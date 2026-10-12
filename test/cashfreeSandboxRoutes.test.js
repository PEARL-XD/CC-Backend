import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHmac, randomUUID } from "node:crypto";
import CashfreeSandboxOrder from "../models/CashfreeSandboxOrder.js";
import { createCashfreeClient } from "../services/cashfree.js";
import {
  CASHFREE_SANDBOX_PATH, CASHFREE_WEBHOOK_PATH,
  captureCashfreeWebhookBody, createCashfreeSandboxRouter,
} from "../routes/cashfreeSandboxRoutes.js";

const adminId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const otherAdminId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const userId = "cccccccccccccccccccccccc";
const env = { CASHFREE_ENV: "sandbox", CASHFREE_APP_ID: "test-app", CASHFREE_SECRET_KEY: "test-secret" };

async function fixture(t, configuration = env) {
  const records = new Map();
  const providerOrders = new Map();
  const calls = [];
  const logs = [];
  const state = { phone: "9876543210", upstreamStatus: 200, mismatch: false, conflict: false, deletedUser: false };
  const matches = (order, filter) => order && Object.entries(filter).every(([key, value]) => {
    if (key === "status") return order.status !== value.$ne;
    return String(order[key]) === String(value);
  });
  const SandboxOrder = {
    async findById(id) { return structuredClone(records.get(id) || null); },
    async findOne(filter) { return structuredClone([...records.values()].find((entry) => matches(entry, filter)) || null); },
    async findOneAndUpdate(filter, update, options) {
      let order = records.get(filter._id);
      if (!order && options.upsert) {
        // Apply the real schema's defaults and validation without connecting to MongoDB.
        const doc = new CashfreeSandboxOrder({ _id: filter._id, ...update.$setOnInsert });
        const error = doc.validateSync();
        if (error) throw error;
        order = { ...doc.toObject(), user: String(doc.user) };
      } else if (!matches(order, filter)) return null;
      Object.assign(order, update.$set);
      records.set(order._id, order);
      return structuredClone(order);
    },
  };
  const User = {
    findById(id) {
      return { select: () => ({ lean: async () => state.deletedUser ? null : ({
        role: id === userId ? "user" : "admin", phone: state.phone,
      }) }) };
    },
  };
  const client = createCashfreeClient({ env: configuration, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (state.upstreamStatus !== 200) return Response.json({ secret: "do-not-disclose" }, { status: state.upstreamStatus });
    if (options.method === "POST") {
      const data = JSON.parse(options.body);
      assert.match(data.order_id, /^[A-Za-z0-9_-]{3,45}$/);
      if (!providerOrders.has(data.order_id)) {
        providerOrders.set(data.order_id, { ...data, order_status: "ACTIVE", payment_session_id: "sandbox-session" });
      }
      if (state.conflict) return Response.json({}, { status: 409 });
      return Response.json(providerOrders.get(data.order_id));
    }
    const remote = providerOrders.get(url.split("/").at(-1));
    return Response.json({ ...remote, ...(state.mismatch ? { order_amount: 10 } : {}) });
  } });
  const app = express();
  app.use(express.json({ limit: "256kb", verify: captureCashfreeWebhookBody }));
  app.use(CASHFREE_SANDBOX_PATH, createCashfreeSandboxRouter({
    authenticateToken(req, res, next) {
      const id = req.get("Authorization")?.replace("Bearer ", "");
      if (![adminId, otherAdminId, userId].includes(id)) return res.sendStatus(401);
      req.user = { id };
      next();
    },
    User, SandboxOrder, client,
    logger: { error: (...args) => logs.push(args) },
  }));
  // Existing paths must fall through unaffected by the optional sandbox router/parser.
  app.post("/api/orders/create", (req, res) => res.json({ received: req.body, rawCaptured: Boolean(req.cashfreeRawBody) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { id = adminId, body, method = body ? "POST" : "GET", headers = {} } = {}) => {
    const response = await fetch(`${base}${path.startsWith("/api/") ? path : CASHFREE_SANDBOX_PATH + path}`, {
      method,
      headers: { ...(id ? { Authorization: `Bearer ${id}` } : {}), "Content-Type": "application/json", ...headers },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text, headers: response.headers };
  };
  return { request, records, providerOrders, calls, logs, state };
}

test("sandbox routes reject guests; absent credentials do not block other paths", async (t) => {
  const f = await fixture(t, {});
  assert.equal((await f.request("/status", { id: null })).status, 401);
  assert.equal((await f.request("/orders", { id: userId, body: { requestId: randomUUID() } })).status, 503);
  const status = await f.request("/status");
  assert.equal(status.body.configured, false);
  assert.equal(status.body.liveCheckoutProvider, "razorpay");
  assert.equal((await f.request("/orders", { body: { requestId: randomUUID() } })).status, 503);
  const legacy = await f.request("/api/orders/create", { id: null, body: { paymentMethod: "COD" } });
  assert.deepEqual(legacy.body, { received: { paymentMethod: "COD" }, rawCaptured: false });
  assert.equal(f.calls.length, 0);
});

test("regular users can create and verify only their own sandbox payments", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/status", { id: userId })).body.configured, true);
  const created = await f.request("/orders", { id: userId, body: { requestId: randomUUID() } });
  assert.equal(created.status, 200);
  const id = created.body.orderId;
  assert.equal(f.records.get(id).user, userId);
  assert.equal((await f.request(`/orders/${id}/verify`, { id: adminId, body: {} })).status, 404);
  f.providerOrders.get(id).order_status = "PAID";
  assert.equal((await f.request(`/orders/${id}/verify`, { id: userId, body: {} })).body.paid, true);
  assert.equal(f.records.size, 1);
});

test("deleted accounts cannot create sandbox payments even with an unexpired token", async (t) => {
  const f = await fixture(t);
  f.state.deletedUser = true;
  assert.equal((await f.request("/orders", { id: userId, body: { requestId: randomUUID() } })).status, 401);
  assert.equal(f.calls.length, 0);
});

test("create uses a fixed test amount and stored phone; retries/concurrency reuse one isolated record", async (t) => {
  const f = await fixture(t);
  const body = { requestId: randomUUID(), amount: 99999, paymentStatus: "PAID", phone: "1111111111" };
  const responses = await Promise.all([f.request("/orders", { body }), f.request("/orders", { body })]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.body.amount, 1);
    assert.equal(response.body.paid, false);
    assert.equal(response.body.testOnly, true);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(f.records.size, 1);
  assert.equal(f.providerOrders.size, 1);
  assert.equal(new Set(f.calls.map((call) => call.options.headers["x-idempotency-key"])).size, 1);
  assert.equal(JSON.parse(f.calls[0].options.body).customer_details.customer_phone, "9876543210");
  const retry = await f.request("/orders", { body });
  assert.equal(retry.body.orderId, responses[0].body.orderId);
  assert.doesNotMatch(JSON.stringify(retry.body), /9876543210|test-secret|idempotency/);
  assert.equal(CashfreeSandboxOrder.collection.name, "cashfree_sandbox_orders");
});

test("invalid requests and missing real phone do not invent customer details or call Cashfree", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/orders", { body: {} })).status, 400);
  f.state.phone = "";
  const missingPhone = await f.request("/orders", { body: { requestId: randomUUID() } });
  assert.equal(missingPhone.body.code, "PHONE_REQUIRED");
  assert.equal(f.calls.length, 0);
  assert.equal(f.records.size, 0);
});

test("failed create is retryable and an existing provider order is recovered after conflict", async (t) => {
  const f = await fixture(t);
  const body = { requestId: randomUUID() };
  f.state.upstreamStatus = 500;
  const failed = await f.request("/orders", { body });
  assert.equal(failed.status, 502);
  const storedId = [...f.records.keys()][0];
  const key = f.calls[0].options.headers["x-idempotency-key"];
  assert.doesNotMatch(JSON.stringify([failed.body, f.logs]), /test-secret|do-not-disclose/);
  f.state.upstreamStatus = 200;
  f.state.conflict = true;
  const retry = await f.request("/orders", { body });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.orderId, storedId);
  assert.equal(f.calls[1].options.headers["x-idempotency-key"], key);
  assert.equal(f.calls[2].options.method, "GET");
});

test("verify enforces ownership, checks amount, and ignores a client supplied success", async (t) => {
  const f = await fixture(t);
  const created = await f.request("/orders", { body: { requestId: randomUUID() } });
  const id = created.body.orderId;
  const path = `/orders/${id}/verify`;
  assert.equal((await f.request(path, { id: otherAdminId, body: {} })).status, 404);
  assert.equal((await f.request("/orders/invalid/verify", { body: {} })).status, 400);
  assert.equal((await f.request(path, { body: { paymentStatus: "PAID" } })).body.paid, false);
  f.providerOrders.get(id).order_status = "PAID";
  f.state.mismatch = true;
  assert.equal((await f.request(path, { body: {} })).body.code, "CASHFREE_ORDER_MISMATCH");
  assert.equal(f.records.get(id).status, "ACTIVE");
  f.state.mismatch = false;
  assert.equal((await f.request(path, { body: {} })).body.paid, true);
  f.providerOrders.get(id).order_status = "ACTIVE";
  assert.equal((await f.request(path, { body: {} })).body.paid, true);
});

test("webhook validates raw signature, checks provider, and handles repeated/out-of-order events", async (t) => {
  const f = await fixture(t);
  const created = await f.request("/orders", { body: { requestId: randomUUID() } });
  const id = created.body.orderId;
  const body = JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: id } } });
  const timestamp = "1720000000000";
  const signature = createHmac("sha256", env.CASHFREE_SECRET_KEY).update(timestamp).update(body).digest("base64");
  const headers = { "x-webhook-signature": signature, "x-webhook-timestamp": timestamp };
  assert.equal((await f.request(CASHFREE_WEBHOOK_PATH, { id: null, body })).status, 401);
  assert.equal((await f.request(CASHFREE_WEBHOOK_PATH, { id: null, body: `${body} `, headers })).status, 401);
  const send = () => f.request(CASHFREE_WEBHOOK_PATH, { id: null, body, headers });
  assert.equal((await send()).status, 200);
  assert.equal(f.records.get(id).status, "ACTIVE");
  f.providerOrders.get(id).order_status = "PAID";
  assert.equal((await send()).status, 200);
  assert.equal(f.records.get(id).status, "PAID");
  const count = f.calls.length;
  f.providerOrders.get(id).order_status = "EXPIRED";
  await send();
  assert.equal(f.records.get(id).status, "PAID");
  assert.equal(f.calls.length, count);
});

test("the same request ID from another admin cannot reuse the first admin's session", async (t) => {
  const f = await fixture(t);
  const body = { requestId: randomUUID() };
  const first = await f.request("/orders", { body });
  const second = await f.request("/orders", { id: otherAdminId, body });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.body.orderId, second.body.orderId);
  assert.equal(f.records.size, 2);
  assert.notEqual(f.calls[0].options.headers["x-idempotency-key"], f.calls[1].options.headers["x-idempotency-key"]);
});

test("production configuration cannot enable the test checkout, and legacy routes remain reachable", async (t) => {
  const f = await fixture(t, { ...env, CASHFREE_ENV: "production" });
  const result = await f.request("/orders", { body: { requestId: randomUUID() } });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "CASHFREE_SANDBOX_ONLY");
  assert.equal(f.calls.length, 0);
  assert.equal(f.records.size, 0);
  assert.equal((await f.request("/api/orders/create", { body: { paymentMethod: "ONLINE" } })).status, 200);
});

test("webhook provider failure requests a retry instead of recording payment", async (t) => {
  const f = await fixture(t);
  const created = await f.request("/orders", { body: { requestId: randomUUID() } });
  const body = JSON.stringify({ data: { order: { order_id: created.body.orderId } } });
  const timestamp = "1720000000000";
  const signature = createHmac("sha256", env.CASHFREE_SECRET_KEY).update(timestamp).update(body).digest("base64");
  f.state.upstreamStatus = 500;
  const result = await f.request(CASHFREE_WEBHOOK_PATH, { id: null, body, headers: {
    "x-webhook-signature": signature, "x-webhook-timestamp": timestamp,
  } });
  assert.equal(result.status, 502);
  assert.equal(f.records.get(created.body.orderId).status, "ACTIVE");
});
