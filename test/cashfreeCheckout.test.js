import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import express from "express";
import { Order as SchemaOrder } from "../models/Order.js";
import { createCashfreeClient } from "../services/cashfree.js";
import { checkoutIdentity, createCashfreeCheckout, publicDeliveryOrder } from "../services/cashfreeCheckout.js";
import { createCashfreeCheckoutRouter } from "../routes/cashfreeCheckoutRoutes.js";
import { captureCashfreeWebhookBody } from "../routes/cashfreeSandboxRoutes.js";

const uid = "aaaaaaaaaaaaaaaaaaaaaaaa";
const other = "bbbbbbbbbbbbbbbbbbbbbbbb";
const env = { CASHFREE_APP_ID: "test-only", CASHFREE_SECRET_KEY: "test-secret", CASHFREE_ENV: "production" };
const snapshot = () => ({ user: uid, items: [{ _id: "item-1", name: "Chicken", price: 135, selectedSize: 500, quantity: 2 }],
  totalAmount: 280, packagingFee: 10, deliveryAddress: { tower: "Legacy tower", flat: "12" },
  paymentMethod: "ONLINE", paymentStatus: "PENDING", orderStatus: "PLACED", statusTimeline: [{ status: "PLACED", time: new Date() }] });
const body = () => ({ requestId: randomUUID(), cartItems: [{ _id: "item-1", selectedSize: 500, quantity: 2 }] });

function fixture(configuration = env) {
  const records = new Map(), provider = new Map(), refunds = new Map(), calls = [], notices = [];
  const state = { offline: false, loseCreate: false, mismatch: false, refundMismatch: false, couponFailure: false };
  const clone = (v) => v == null ? null : structuredClone(v);
  function match(row, filter) {
    if (!row) return false;
    return Object.entries(filter).every(([key, value]) => {
      if (key === "$or") return value.some((f) => match(row, f));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if ("$ne" in value) return row[key] !== value.$ne;
        if ("$in" in value) return value.$in.includes(row[key]);
        if ("$nin" in value) return !value.$nin.includes(row[key]);
        if ("$exists" in value) return (row[key] !== undefined) === value.$exists;
      }
      return String(row[key]) === String(value);
    });
  }
  function query(execute) {
    return { select() { return this; }, sort() { return this; }, limit() { return this; }, then(resolve, reject) { return Promise.resolve().then(execute).then(resolve, reject); } };
  }
  function update(filter, change, options = {}) {
    let row = [...records.values()].find((v) => match(v, filter));
    if (!row && options.upsert) {
      const doc = new SchemaOrder({ _id: filter._id, ...change.$setOnInsert, createdAt: new Date() });
      const error = doc.validateSync();
      if (error) throw error;
      row = { ...doc.toObject(), _id: String(doc._id), user: String(doc.user) };
      if (records.has(row._id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
    }
    if (!row) return null;
    Object.assign(row, change.$set);
    for (const [key, value] of Object.entries(change.$push || {})) (row[key] ??= []).push(value);
    records.set(String(row._id), row);
    return clone(row);
  }
  const Order = {
    findById: (id) => query(() => clone(records.get(String(id)))),
    findOneAndUpdate: (f, u, o) => query(() => update(f, u, o)),
    updateOne: (f, u) => query(() => update(f, u)),
    find: (f) => query(() => [...records.values()].filter((r) => match(r, f)).map(clone)),
  };
  const client = createCashfreeClient({ env: configuration, production: true, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.ok(url.startsWith("https://api.cashfree.com/pg/"));
    if (state.offline) return Response.json({}, { status: 503 });
    const path = new URL(url).pathname.split('/').slice(2);
    if (path[2] === "refunds") {
      const refundId = options.body ? JSON.parse(options.body).refund_id : path[3];
      if (options.body && !refunds.has(refundId)) {
        const payload = JSON.parse(options.body);
        refunds.set(refundId, { ...payload, order_id: path[1], refund_currency: "INR", refund_status: "PENDING" });
      }
      const row = refunds.get(refundId);
      return row ? Response.json({ ...row, ...(state.refundMismatch ? { refund_amount: 1 } : {}) }) : Response.json({}, { status: 404 });
    }
    if (options.body) {
      const payload = JSON.parse(options.body);
      if (!provider.has(payload.order_id)) provider.set(payload.order_id, { ...payload, order_status: "ACTIVE", payment_session_id: "live-session" });
      if (state.loseCreate) return Response.json({}, { status: 504 });
      return Response.json(provider.get(payload.order_id));
    }
    const row = provider.get(path[1]);
    return row ? Response.json({ ...row, ...(state.mismatch ? { order_amount: 1 } : {}) }) : Response.json({}, { status: 404 });
  } });
  const payments = createCashfreeCheckout({ Order, client,
    reserveCoupon: async () => { if (state.couponFailure) throw new Error("coupon conflict"); },
    onPaid: async (o) => notices.push(`paid:${o._id}`), onCancelled: async (o) => notices.push(`cancel:${o._id}`), logger: { error() {} },
  });
  const create = async (request = body(), data = snapshot()) => {
    const identity = checkoutIdentity(data.user, request);
    return payments.create(identity, data, "9876543210");
  };
  return { Order, client, payments, records, provider, refunds, calls, notices, state, create };
}

test("live client requires production credentials; sandbox API stays isolated", async () => {
  for (const config of [{}, { ...env, CASHFREE_ENV: "sandbox" }, { ...env, CASHFREE_SECRET_KEY: "" }]) {
    const f = fixture(config);
    await assert.rejects(f.create(), { code: "CASHFREE_NOT_CONFIGURED" });
    assert.equal(f.calls.length, 0);
    assert.equal(f.records.size, 0);
  }
  assert.throws(() => createCashfreeClient({ env }).requireSandbox(), { code: "CASHFREE_SANDBOX_ONLY" });
});

test("create persists server total/address and concurrent retries reuse one real order", async () => {
  const f = fixture(), request = body();
  const results = await Promise.all([f.create(request), f.create(request)]);
  assert.equal(results[0].localOrderId, results[1].localOrderId);
  assert.equal(f.records.size, 1);
  assert.equal(f.provider.size, 1);
  assert.equal(results[0].amount, 28000);
  assert.equal(results[0].environment, "production");
  assert.equal(results[0].paid, false);
  const row = f.records.get(results[0].localOrderId);
  assert.equal(row.deliveryAddress.tower, "Legacy tower");
  const posted = f.calls.filter((c) => c.options.method === "POST");
  assert.equal(new Set(posted.map((c) => c.options.headers['x-idempotency-key'])).size, 1);
  assert.equal(f.notices.length, 0);
});

test("lost provider response recovers; changed payload/account cannot reuse checkout", async () => {
  const f = fixture(), request = body();
  f.state.loseCreate = true;
  const result = await f.create(request);
  assert.equal(result.paid, false);
  assert.equal((await f.payments.resume(checkoutIdentity(uid, request), uid)).localOrderId, result.localOrderId);
  await assert.rejects(f.payments.resume(checkoutIdentity(uid, { ...request, schedule: 'tomorrow' }), uid), { code: 'CHECKOUT_CHANGED' });
  await assert.rejects(f.payments.owned(result.localOrderId, other), { status: 404 });
  assert.notEqual(checkoutIdentity(uid, request).id, checkoutIdentity(other, request).id);
});

test("only verified PAID confirms; duplicate and out-of-order callbacks never downgrade", async () => {
  const f = fixture(), result = await f.create();
  const row = await f.payments.owned(result.localOrderId, uid);
  f.state.mismatch = true;
  await assert.rejects(f.payments.reconcile(row), { code: 'CASHFREE_ORDER_MISMATCH' });
  assert.equal(f.records.get(row._id).paymentStatus, 'PENDING');
  f.state.mismatch = false;
  f.provider.get(result.cashfreeOrderId).order_status = 'PAID';
  await Promise.all([f.payments.reconcile(row), f.payments.reconcile(row)]);
  assert.equal(f.records.get(row._id).orderStatus, 'CONFIRMED');
  assert.equal(f.records.get(row._id).statusTimeline.filter((s) => s.status === 'CONFIRMED').length, 1);
  assert.equal(f.notices.filter((n) => n.startsWith('paid:')).length, 1);
  f.provider.get(result.cashfreeOrderId).order_status = 'EXPIRED';
  await f.payments.reconcile(row);
  assert.equal(f.records.get(row._id).paymentStatus, 'PAID');
  assert.equal(f.records.get(row._id).orderStatus, 'CONFIRMED');
});

test("cancelled orders never reopen; late payment is refunded once at full stored amount", async () => {
  const f = fixture(), result = await f.create();
  await f.payments.cancel(await f.payments.owned(result.localOrderId, uid));
  f.provider.get(result.cashfreeOrderId).order_status = 'PAID';
  const cancelled = await f.payments.owned(result.localOrderId, uid);
  await Promise.all([f.payments.reconcile(cancelled), f.payments.reconcile(cancelled)]);
  assert.equal(f.records.get(cancelled._id).orderStatus, 'CANCELLED');
  assert.equal(f.records.get(cancelled._id).refundStatus, 'PENDING');
  assert.equal(f.notices.filter((n) => n.startsWith('paid:')).length, 0);
  assert.equal(f.refunds.size, 1);
  const refund = [...f.refunds.values()][0];
  assert.equal(refund.refund_amount, 280);
  refund.refund_status = 'SUCCESS';
  await f.payments.sweep();
  assert.equal(f.records.get(cancelled._id).refundStatus, 'SUCCESS');
  assert.equal((await f.payments.session(await f.payments.owned(cancelled._id, uid))).paymentSessionId, '');
});

test("refund approval/hold states remain reconcilable; rejection stops automatic retries", async () => {
  const f = fixture(), result = await f.create();
  f.provider.get(result.cashfreeOrderId).order_status = 'PAID';
  await f.payments.cancel(await f.payments.owned(result.localOrderId, uid));
  const remote = [...f.refunds.values()][0];
  for (const status of ['PENDING_APPROVAL', 'ONHOLD', 'REJECTED']) {
    remote.refund_status = status;
    await f.payments.sweep();
    assert.equal(f.records.get(result.localOrderId).refundStatus, status);
    assert.equal(new SchemaOrder({ ...snapshot(), refundStatus: status }).validateSync(), undefined);
  }
  const count = f.calls.length;
  await f.payments.sweep();
  assert.equal(f.calls.length, count);
  assert.equal(f.refunds.size, 1);
});

test("refund failures persist for retry; invalid amounts never appear as refunded", async () => {
  const f = fixture(), result = await f.create();
  f.provider.get(result.cashfreeOrderId).order_status = 'PAID';
  await f.payments.reconcile(await f.payments.owned(result.localOrderId, uid));
  f.state.offline = true;
  await f.payments.cancel(await f.payments.owned(result.localOrderId, uid));
  assert.equal(f.records.get(result.localOrderId).orderStatus, 'CANCELLED');
  f.state.offline = false;
  f.state.refundMismatch = true;
  await f.payments.sweep();
  assert.equal(f.records.get(result.localOrderId).refundStatus, 'REQUESTED');
  f.state.refundMismatch = false;
  await f.payments.sweep();
  assert.equal(f.records.get(result.localOrderId).refundStatus, 'PENDING');
});

test("expired/cancelled sessions stop polling; coupon conflict never opens payment", async () => {
  const f = fixture(), result = await f.create();
  await f.payments.cancel(await f.payments.owned(result.localOrderId, uid));
  f.provider.get(result.cashfreeOrderId).order_status = 'EXPIRED';
  await f.payments.sweep();
  assert.equal(f.records.get(result.localOrderId).paymentStatus, 'FAILED');
  f.state.couponFailure = true;
  const count = f.calls.length;
  await assert.rejects(f.create(body(), { ...snapshot(), couponId: other }));
  assert.equal(f.calls.length, count);
});

test("schema preserves legacy records; private session/phone fields are not public", () => {
  const doc = new SchemaOrder(snapshot());
  assert.equal(doc.validateSync(), undefined);
  assert.equal(doc.paymentProvider, undefined);
  assert.equal(SchemaOrder.schema.path('cashfreeSessionId').options.select, false);
  const publicOrder = publicDeliveryOrder({ ...snapshot(), cashfreeSessionId: 'private', cashfreeCustomerPhone: 'private', checkoutFingerprint: 'private' });
  assert.equal(publicOrder.cashfreeSessionId, undefined);
  assert.equal(publicOrder.cashfreeCustomerPhone, undefined);
});

test("live routes enforce owner auth and exact signed webhook body; spoofed paid ignored", async (t) => {
  const f = fixture(), result = await f.create();
  const app = express();
  app.use(express.json({ verify: captureCashfreeWebhookBody }));
  app.use('/api/payments/cashfree', createCashfreeCheckoutRouter({
    ...f,
    authenticateToken(req, res, next) {
      const id = req.get('Authorization');
      if (![uid, other].includes(id)) return res.sendStatus(401);
      req.user = { id }; next();
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const request = (path, data, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/payments/cashfree${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: data,
  });
  const path = `/orders/${result.localOrderId}/verify`;
  assert.equal((await request(path, '{}')).status, 401);
  assert.equal((await request(path, '{}', { Authorization: other })).status, 404);
  const checked = await request(path, '{"paid":true}', { Authorization: uid });
  assert.equal((await checked.json()).paid, false);
  const raw = JSON.stringify({ data: { order: { order_id: result.cashfreeOrderId, order_status: 'PAID' } } });
  assert.equal((await request('/webhook', raw)).status, 401);
  const ts = String(Date.now());
  const headers = { 'x-webhook-timestamp': ts, 'x-webhook-signature': createHmac('sha256', env.CASHFREE_SECRET_KEY).update(ts + raw).digest('base64') };
  assert.equal((await request('/webhook', raw, headers)).status, 200);
  assert.equal(f.records.get(result.localOrderId).paymentStatus, 'PENDING');
  f.provider.get(result.cashfreeOrderId).order_status = 'PAID';
  assert.equal((await request('/webhook', raw, headers)).status, 200);
  assert.equal(f.records.get(result.localOrderId).paymentStatus, 'PAID');
  assert.equal((await request('/webhook', raw + ' ', headers)).status, 401);
});
