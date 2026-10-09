import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createCashfreeClient, CashfreeError, validateCashfreeOrder } from "../services/cashfree.js";

const env = { CASHFREE_ENV: "sandbox", CASHFREE_APP_ID: "test-app", CASHFREE_SECRET_KEY: "test-secret" };

test("Cashfree configuration is lazy and cannot switch live checkout to production", async () => {
  for (const settings of [{}, { ...env, CASHFREE_ENV: "production" }, { ...env, CASHFREE_ENV: "typo" }]) {
    let calls = 0;
    const client = createCashfreeClient({ env: settings, fetchImpl: () => { calls++; } });
    assert.equal(client.status().configured, false);
    await assert.rejects(client.getOrder("test"), { status: 503 });
    assert.equal(calls, 0);
  }
  assert.deepEqual(createCashfreeClient({ env }).status(), { configured: true, environment: "sandbox" });
});

test("Cashfree sends sandbox credentials only to the fixed host with idempotency and a deadline", async () => {
  const calls = [];
  const client = createCashfreeClient({ env, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ order_id: "test" });
  } });
  await client.createOrder({ order_id: "test", order_amount: 1 }, "test-uuid");
  await client.getOrder("test/id");
  assert.equal(calls[0].url, "https://sandbox.cashfree.com/pg/orders");
  assert.equal(calls[0].options.headers["x-api-version"], "2026-01-01");
  assert.equal(calls[0].options.headers["x-client-secret"], "test-secret");
  assert.equal(calls[0].options.headers["x-idempotency-key"], "test-uuid");
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[1].url, "https://sandbox.cashfree.com/pg/orders/test%2Fid");
  assert.equal(calls[1].options.method, "GET");
});

test("upstream errors and malformed JSON never disclose raw payloads or secrets", async () => {
  for (const status of [400, 401, 409, 422, 429, 500]) {
    const client = createCashfreeClient({ env, fetchImpl: async () => Response.json({ secret: "private-customer-value" }, { status }) });
    await assert.rejects(client.getOrder("test"), (error) => {
      assert.ok(error instanceof CashfreeError);
      assert.equal(error.upstreamStatus, status);
      assert.doesNotMatch(error.message, /private-customer|test-secret/);
      return true;
    });
  }
  const invalidJson = createCashfreeClient({ env, fetchImpl: async () => new Response("not JSON") });
  await assert.rejects(invalidJson.getOrder("test"), { code: "CASHFREE_UNAVAILABLE" });
  const timeout = createCashfreeClient({ env, fetchImpl: async () => { throw new DOMException("secret", "TimeoutError"); } });
  await assert.rejects(timeout.getOrder("test"), { code: "CASHFREE_TIMEOUT", status: 504 });
});

test("webhooks authenticate the exact raw bytes and reject missing/tampered signatures", () => {
  const client = createCashfreeClient({ env });
  const raw = Buffer.from('{"order_amount":1.00}');
  const timestamp = "1720000000000";
  const signature = createHmac("sha256", env.CASHFREE_SECRET_KEY).update(timestamp).update(raw).digest("base64");
  assert.equal(client.verifyWebhook(raw, signature, timestamp), true);
  assert.equal(client.verifyWebhook(Buffer.from('{"order_amount":1}'), signature, timestamp), false);
  assert.equal(client.verifyWebhook(raw, signature, "1720000000001"), false);
  assert.equal(client.verifyWebhook(raw, "invalid", timestamp), false);
  assert.equal(client.verifyWebhook(undefined, signature, timestamp), false);
  assert.equal(client.verifyWebhook(raw, signature, undefined), false);
});

test("verification requires matching identity, amount, currency and known order status", () => {
  const local = { _id: "test", amountPaise: 100 };
  const remote = { order_id: "test", order_amount: 1, order_currency: "INR", order_status: "PAID" };
  assert.doesNotThrow(() => validateCashfreeOrder(remote, local));
  for (const override of [
    { order_id: "another" }, { order_amount: 0 }, { order_amount: "1" },
    { order_amount: 1.001 }, { order_currency: "USD" }, { order_status: "SUCCESS" },
  ]) {
    assert.throws(() => validateCashfreeOrder({ ...remote, ...override }, local), { code: "CASHFREE_ORDER_MISMATCH" });
  }
});
