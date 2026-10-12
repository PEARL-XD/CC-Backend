import { createHmac, timingSafeEqual } from "node:crypto";

export class CashfreeError extends Error {
  constructor(code, message, status = 502, upstreamStatus) {
    super(message);
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

export function createCashfreeClient({ env = process.env, fetchImpl = fetch, timeoutMs = 15_000, production = false } = {}) {
  function configuration() {
    const environment = String(env.CASHFREE_ENV || "sandbox").trim().toLowerCase();
    const appId = String(env.CASHFREE_APP_ID || "").trim();
    const secret = String(env.CASHFREE_SECRET_KEY || "").trim();
    return { environment, appId, secret };
  }

  function requireSandbox() {
    const config = configuration();
    if (config.environment !== "sandbox") {
      throw new CashfreeError("CASHFREE_SANDBOX_ONLY", "Cashfree is currently available for sandbox testing only.", 503);
    }
    if (!config.appId || !config.secret) {
      throw new CashfreeError("CASHFREE_NOT_CONFIGURED", "Cashfree sandbox credentials are not configured.", 503);
    }
    return config;
  }

  async function request(path, { body, idempotencyKey } = {}) {
    const config = requireConfigured();
    try {
      const response = await fetchImpl(`https://${production ? "api" : "sandbox"}.cashfree.com/pg${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "x-api-version": "2026-01-01",
          "x-client-id": config.appId,
          "x-client-secret": config.secret,
          ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      // Never return provider error bodies: they can contain customer/credential data.
      if (!response.ok) {
        await response.body?.cancel();
        throw new CashfreeError("CASHFREE_REQUEST_FAILED", "Cashfree could not complete the request. Retry the same payment reference.", 502, response.status);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof CashfreeError) throw error;
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new CashfreeError("CASHFREE_TIMEOUT", "Cashfree timed out. Retry with the same request ID.", 504);
      }
      throw new CashfreeError("CASHFREE_UNAVAILABLE", "Cashfree is temporarily unavailable.");
    }
  }

  function requireConfigured() {
    if (!production) return requireSandbox();
    const config = configuration();
    if (config.environment !== "production" || !config.appId || !config.secret) {
      throw new CashfreeError("CASHFREE_NOT_CONFIGURED", "Live Cashfree checkout is not configured. Please try again later.", 503);
    }
    return config;
  }

  return {
    status() {
      const { environment, appId, secret } = configuration();
      return { configured: environment === "sandbox" && Boolean(appId && secret), environment: "sandbox" };
    },
    requireSandbox,
    requireConfigured,
    createOrder: (body, idempotencyKey) => request("/orders", { body, idempotencyKey }),
    getOrder: (orderId) => request(`/orders/${encodeURIComponent(orderId)}`),
    createRefund: (orderId, body, idempotencyKey) => request(`/orders/${encodeURIComponent(orderId)}/refunds`, { body, idempotencyKey }),
    getRefund: (orderId, refundId) => request(`/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`),
    verifyWebhook(rawBody, signature, timestamp) {
      const { secret } = requireConfigured();
      if (!Buffer.isBuffer(rawBody) || typeof signature !== "string" ||
          !/^[A-Za-z0-9+/]{43}=$/.test(signature) || typeof timestamp !== "string" ||
          !/^\d{10,16}$/.test(timestamp)) return false;
      const expected = createHmac("sha256", secret).update(timestamp).update(rawBody).digest();
      const supplied = Buffer.from(signature, "base64");
      return supplied.length === expected.length && timingSafeEqual(expected, supplied);
    },
  };
}

export function validateCashfreeOrder(remote, local) {
  if (!remote || remote.order_id !== local._id || remote.order_currency !== "INR" ||
      typeof remote.order_amount !== "number" || remote.order_amount !== local.amountPaise / 100 ||
      !["ACTIVE", "PAID", "EXPIRED", "TERMINATED", "TERMINATION_REQUESTED"].includes(remote.order_status)) {
    throw new CashfreeError("CASHFREE_ORDER_MISMATCH", "Cashfree returned an unexpected order. No payment was recorded.");
  }
}
