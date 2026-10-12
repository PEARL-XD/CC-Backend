import express from "express";
import rateLimit from "express-rate-limit";
import { CashfreeError } from "../services/cashfree.js";
import { liveOrderPattern } from "../services/cashfreeCheckout.js";

export const CASHFREE_CHECKOUT_PATH = "/api/payments/cashfree";
export const CASHFREE_LIVE_WEBHOOK_PATH = `${CASHFREE_CHECKOUT_PATH}/webhook`;

export function createCashfreeCheckoutRouter({ authenticateToken, Order, client, payments }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.post("/webhook", rateLimit({ windowMs: 60_000, limit: 120 }), async (req, res) => {
    if (!client.verifyWebhook(req.cashfreeRawBody, req.get("x-webhook-signature"), req.get("x-webhook-timestamp"))) {
      return res.status(401).json({ error: "Invalid webhook signature." });
    }
    const id = req.body?.data?.order?.order_id || req.body?.data?.refund?.order_id;
    if (typeof id !== "string" || !liveOrderPattern.test(id)) return res.json({ received: true, ignored: true });
    const order = await Order.findById(id.slice(3));
    if (!order || order.paymentProvider !== "cashfree") return res.json({ received: true, ignored: true });
    await payments.reconcile(order);
    return res.json({ received: true });
  });
  router.use(authenticateToken);
  router.use(rateLimit({ windowMs: 60_000, limit: 60 }));
  router.post("/orders/:id/session", async (req, res) => {
    res.json(await payments.session(await payments.owned(req.params.id, req.user.id)));
  });
  router.post("/orders/:id/verify", async (req, res) => {
    res.json(payments.response(await payments.reconcile(await payments.owned(req.params.id, req.user.id))));
  });
  router.use((error, _req, res, _next) => {
    console.error("Cashfree checkout request failed", { code: error.code || "INTERNAL", upstreamStatus: error.upstreamStatus });
    res.status(error instanceof CashfreeError ? error.status : 500).json({
      error: error instanceof CashfreeError ? error.message : "Unable to verify payment. Check your order before paying again.",
      code: error instanceof CashfreeError ? error.code : "CASHFREE_FAILED",
    });
  });
  return router;
}
