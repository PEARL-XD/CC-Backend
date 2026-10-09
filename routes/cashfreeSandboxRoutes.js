import express from "express";
import { createHash, randomUUID } from "node:crypto";
import rateLimit from "express-rate-limit";
import { CashfreeError, validateCashfreeOrder } from "../services/cashfree.js";

export const CASHFREE_SANDBOX_PATH = "/api/payments/cashfree/sandbox";
export const CASHFREE_WEBHOOK_PATH = `${CASHFREE_SANDBOX_PATH}/webhook`;
const sandboxOrderIdPattern = /^cf_sbx_[a-f0-9]{32}$/;

export function captureCashfreeWebhookBody(req, _res, buffer) {
  if (req.originalUrl.split("?")[0].replace(/\/$/, "") === CASHFREE_WEBHOOK_PATH) {
    req.cashfreeRawBody = Buffer.from(buffer);
  }
}

const publicOrder = (order) => ({
  success: true,
  provider: "cashfree",
  environment: "sandbox",
  testOnly: true,
  orderId: order._id,
  amount: order.amountPaise / 100,
  currency: order.currency,
  status: order.status,
  paid: order.status === "PAID",
  paymentSessionId: order.paymentSessionId,
});

export function createCashfreeSandboxRouter({ authenticateToken, User, SandboxOrder, client, logger = console }) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  async function synchronize(order, remote) {
    validateCashfreeOrder(remote, order);
    // Late/repeated webhooks must never change an already paid test back to ACTIVE.
    const updated = await SandboxOrder.findOneAndUpdate(
      { _id: order._id, status: { $ne: "PAID" } },
      { $set: {
        status: remote.order_status,
        ...(typeof remote.payment_session_id === "string" && remote.payment_session_id
          ? { paymentSessionId: remote.payment_session_id } : {}),
      } },
      { new: true, runValidators: true },
    );
    return updated || await SandboxOrder.findById(order._id);
  }

  router.post("/webhook", rateLimit({ windowMs: 60_000, limit: 120 }), async (req, res) => {
    if (!client.verifyWebhook(req.cashfreeRawBody, req.get("x-webhook-signature"), req.get("x-webhook-timestamp"))) {
      return res.status(401).json({ error: "Invalid Cashfree webhook signature." });
    }
    const orderId = req.body?.data?.order?.order_id;
    if (typeof orderId !== "string" || !sandboxOrderIdPattern.test(orderId)) {
      return res.json({ received: true, ignored: true });
    }
    const order = await SandboxOrder.findById(orderId);
    if (!order) return res.json({ received: true, ignored: true });
    if (order.status !== "PAID") {
      // A signed callback is still reconciled with Cashfree, not a client success flag.
      await synchronize(order, await client.getOrder(order._id));
    }
    return res.json({ received: true });
  });

  router.use(authenticateToken);
  router.use(rateLimit({ windowMs: 60_000, limit: 30 }));
  router.use(async (req, res, next) => {
    const user = await User.findById(req.user.id).select("phone").lean();
    if (!user) return res.status(401).json({ error: "Account no longer exists. Please sign in again." });
    req.cashfreeCustomer = user;
    next();
  });

  router.get("/status", (_req, res) => {
    res.json({ ...client.status(), liveCheckoutProvider: "razorpay", testOnly: true });
  });

  router.post("/orders", async (req, res) => {
    client.requireSandbox();
    const requestId = req.body?.requestId;
    if (typeof requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) {
      return res.status(400).json({ error: "A UUID v4 requestId is required. Reuse it when retrying the same test payment." });
    }
    // Keep the deterministic ID within Cashfree's 45-character limit.
    const orderId = `cf_sbx_${createHash("sha256").update(`${req.user.id}:${requestId.toLowerCase()}`).digest("hex").slice(0, 32)}`;
    let order = await SandboxOrder.findById(orderId);
    if (!order) {
      let phone = String(req.cashfreeCustomer.phone || "").replace(/\D/g, "");
      if (phone.length === 12 && phone.startsWith("91")) phone = phone.slice(2);
      if (!/^[6-9]\d{9}$/.test(phone)) {
        return res.status(400).json({ code: "PHONE_REQUIRED", error: "Add your mobile number to your profile before testing." });
      }
      try {
        order = await SandboxOrder.findOneAndUpdate({ _id: orderId }, { $setOnInsert: {
          user: req.user.id,
          idempotencyKey: randomUUID(),
          customerPhone: phone,
          amountPaise: 100,
        } }, { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
        order = await SandboxOrder.findById(orderId);
        if (!order) throw error;
      }
    }
    if (order.paymentSessionId || order.status === "PAID") return res.json(publicOrder(order));

    let remote;
    try {
      remote = await client.createOrder({
        order_id: order._id,
        order_amount: order.amountPaise / 100,
        order_currency: order.currency,
        customer_details: { customer_id: String(order.user), customer_phone: order.customerPhone },
        order_note: "CleanChops sandbox test only - not a delivery order",
      }, order.idempotencyKey);
    } catch (error) {
      if (!(error instanceof CashfreeError) || error.upstreamStatus !== 409) throw error;
      remote = await client.getOrder(order._id);
    }
    if (typeof remote?.payment_session_id !== "string" || !remote.payment_session_id) {
      throw new CashfreeError("CASHFREE_SESSION_MISSING", "Cashfree did not return a payment session. Retry with the same request ID.");
    }
    order = await synchronize(order, remote);
    return res.json(publicOrder(order));
  });

  router.post("/orders/:orderId/verify", async (req, res) => {
    client.requireSandbox();
    if (!sandboxOrderIdPattern.test(req.params.orderId)) {
      return res.status(400).json({ error: "Invalid sandbox order ID." });
    }
    const order = await SandboxOrder.findOne({ _id: req.params.orderId, user: req.user.id });
    if (!order) return res.status(404).json({ error: "Sandbox order not found." });
    if (order.status === "PAID") return res.json(publicOrder(order));
    return res.json(publicOrder(await synchronize(order, await client.getOrder(order._id))));
  });

  router.use((error, req, res, _next) => {
    const known = error instanceof CashfreeError;
    const code = known ? error.code : "CASHFREE_TEST_FAILED";
    logger.error("Cashfree sandbox request failed", { code, upstreamStatus: known ? error.upstreamStatus : undefined });
    res.status(known ? error.status : 500).json({
      code,
      error: known ? error.message : "Could not complete the sandbox test. Please retry.",
    });
  });
  return router;
}
