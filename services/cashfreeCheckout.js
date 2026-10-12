import { createHash } from "node:crypto";
import { CashfreeError, validateCashfreeOrder } from "./cashfree.js";

const secretFields = "+cashfreeSessionId +cashfreeCustomerPhone +checkoutFingerprint";
const terminalRefundStates = ["SUCCESS", "FAILED", "CANCELLED", "REJECTED"];
const refundStates = [...terminalRefundStates, "PENDING", "PENDING_APPROVAL", "ONHOLD"];
export const liveOrderPattern = /^cc_[a-f0-9]{24}$/;
const fail = (code, message, status = 409) => { throw new CashfreeError(code, message, status); };

export function checkoutIdentity(userId, body) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.requestId || "")) {
    fail("REQUEST_ID_REQUIRED", "A payment request reference is required.", 400);
  }
  const id = createHash("sha256").update(`cashfree:${userId}:${body.requestId.toLowerCase()}`).digest("hex").slice(0, 24);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    cartItems: body.cartItems, schedule: body.schedule || "", silentDelivery: body.silentDelivery === true,
    couponCode: String(body.couponCode || "").trim().toUpperCase(),
    locationKey: String(body.locationKey || ""),
  })).digest("hex");
  return { id, fingerprint };
}

function uuidFor(value) {
  const h = createHash("sha256").update(value).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function cashfreeResponse(order) {
  return {
    success: true, localOrderId: String(order._id), paymentProvider: "cashfree",
    cashfreeOrderId: order.cashfreeOrderId, environment: "production", currency: "INR",
    amount: Math.round(order.totalAmount * 100), paymentMethod: "ONLINE",
    requiresPayment: order.paymentStatus !== "PAID" && order.orderStatus !== "CANCELLED",
    paid: order.paymentStatus === "PAID", paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus, cashfreeStatus: order.cashfreeStatus,
    refundStatus: order.refundStatus || null,
    paymentSessionId: order.orderStatus === "CANCELLED" ? "" : (order.cashfreeSessionId || ""),
  };
}

export function publicDeliveryOrder(order) {
  const result = order.toObject ? order.toObject() : { ...order };
  for (const key of ["cashfreeSessionId", "cashfreeCustomerPhone", "checkoutFingerprint"]) delete result[key];
  return result;
}

export function createCashfreeCheckout({ Order, client, reserveCoupon, onPaid = async () => {}, onCancelled = async () => {}, logger = console }) {
  const read = (id) => Order.findById(id).select(secretFields);
  function assertLive(order) {
    if (!order || order.paymentProvider !== "cashfree" || order.cashfreeEnvironment !== "production") {
      fail("ORDER_NOT_FOUND", "Cashfree order not found.", 404);
    }
  }
  async function owned(id, userId) {
    if (!/^[a-f0-9]{24}$/i.test(id)) fail("ORDER_NOT_FOUND", "Order not found.", 404);
    const order = await read(id);
    assertLive(order);
    if (String(order.user) !== String(userId)) fail("ORDER_NOT_FOUND", "Order not found.", 404);
    return order;
  }

  async function refund(order) {
    if (order.paymentStatus !== "PAID" || order.orderStatus !== "CANCELLED" ||
        terminalRefundStates.includes(order.refundStatus)) return order;
    const refundId = `cc_ref_${order._id}`;
    await Order.updateOne({ _id: order._id, refundStatus: { $exists: false } }, {
      $set: { refundStatus: "REQUESTED", cashfreeRefundId: refundId },
    });
    let remote;
    try {
      remote = await client.getRefund(order.cashfreeOrderId, refundId);
    } catch (error) {
      if (error.upstreamStatus !== 404) throw error;
      remote = await client.createRefund(order.cashfreeOrderId, {
        refund_id: refundId, refund_amount: Math.round(order.totalAmount * 100) / 100,
        refund_note: "Cancelled CleanChops order", refund_speed: "STANDARD",
      }, uuidFor(refundId));
    }
    const refunds = Array.isArray(remote) ? remote : [remote];
    if (!refunds.length || refunds.some((r) => r.order_id !== order.cashfreeOrderId || r.refund_id !== refundId ||
        r.refund_currency !== "INR" || typeof r.refund_amount !== "number" || r.refund_amount <= 0 ||
        !refundStates.includes(r.refund_status)) ||
        Math.round(refunds.reduce((sum, r) => sum + r.refund_amount, 0) * 100) !== Math.round(order.totalAmount * 100)) {
      fail("CASHFREE_REFUND_MISMATCH", "Refund confirmation could not be verified.", 502);
    }
    const statuses = refunds.map((r) => r.refund_status);
    const status = statuses.every((s) => s === "SUCCESS") ? "SUCCESS"
      : ["FAILED", "REJECTED", "CANCELLED", "ONHOLD", "PENDING_APPROVAL"].find((s) => statuses.includes(s)) || "PENDING";
    await Order.updateOne({ _id: order._id, refundStatus: { $ne: "SUCCESS" } }, {
      $set: { refundStatus: status, cashfreeRefundId: refundId },
    });
    if (["FAILED", "REJECTED", "CANCELLED", "ONHOLD", "PENDING_APPROVAL"].includes(status)) {
      logger.error("Cashfree refund requires attention", { orderId: String(order._id), refundId, status });
    }
    return read(order._id);
  }

  async function reconcile(order, remote) {
    assertLive(order);
    remote ??= await client.getOrder(order.cashfreeOrderId);
    validateCashfreeOrder(remote, { _id: order.cashfreeOrderId, amountPaise: Math.round(order.totalAmount * 100) });
    const fields = { cashfreeStatus: remote.order_status, paymentCheckedAt: new Date() };
    if (typeof remote.payment_session_id === "string" && remote.payment_session_id) fields.cashfreeSessionId = remote.payment_session_id;
    await Order.updateOne({ _id: order._id, paymentStatus: { $ne: "PAID" } }, { $set: fields });
    if (remote.order_status === "PAID") {
      // Atomic transition: verify, webhook and both servers cannot confirm twice.
      const confirmed = await Order.findOneAndUpdate({ _id: order._id, paymentStatus: { $ne: "PAID" }, orderStatus: { $ne: "CANCELLED" } }, {
        $set: { ...fields, paymentStatus: "PAID", orderStatus: "CONFIRMED" },
        $push: { statusTimeline: { status: "CONFIRMED", time: new Date() } },
      }, { new: true });
      if (confirmed) {
        await onPaid(confirmed).catch(() => logger.error("Cashfree paid notification failed", { orderId: String(order._id) }));
      } else {
        // A payment completed after cancellation must be refunded, never fulfilled.
        await Order.updateOne({ _id: order._id, orderStatus: "CANCELLED" }, { $set: { ...fields, paymentStatus: "PAID" } });
      }
    } else if (["EXPIRED", "TERMINATED"].includes(remote.order_status)) {
      await Order.findOneAndUpdate({ _id: order._id, paymentStatus: { $ne: "PAID" }, orderStatus: { $ne: "CANCELLED" } }, {
        $set: { paymentStatus: "FAILED", orderStatus: "CANCELLED" },
        $push: { statusTimeline: { status: "CANCELLED", time: new Date() } },
      });
      await Order.updateOne({ _id: order._id, paymentStatus: "PENDING", orderStatus: "CANCELLED" }, {
        $set: { paymentStatus: "FAILED" },
      });
    }
    return refund(await read(order._id));
  }

  async function session(order) {
    assertLive(order);
    client.requireConfigured();
    if (order.orderStatus === "CANCELLED") {
      try { return cashfreeResponse(await reconcile(order)); }
      catch (error) {
        if (error.upstreamStatus !== 404 || order.cashfreeSessionId) throw error;
        return cashfreeResponse(order);
      }
    }
    if (order.paymentStatus === "PAID") return cashfreeResponse(order);
    if (reserveCoupon && order.couponId) await reserveCoupon(order);
    if (order.cashfreeSessionId) return cashfreeResponse(await reconcile(order));
    let remote;
    try {
      remote = await client.createOrder({
        order_id: order.cashfreeOrderId, order_amount: Math.round(order.totalAmount * 100) / 100, order_currency: "INR",
        customer_details: { customer_id: String(order.user), customer_phone: order.cashfreeCustomerPhone },
        order_note: `CleanChops order ${order._id}`,
        order_expiry_time: new Date(new Date(order.createdAt).getTime() + 30 * 60_000).toISOString(),
      }, uuidFor(order.cashfreeOrderId));
    } catch (error) {
      // A lost create response can be recovered even after the idempotency window.
      try { remote = await client.getOrder(order.cashfreeOrderId); } catch { throw error; }
    }
    if (!remote?.payment_session_id) fail("CASHFREE_SESSION_MISSING", "Could not open payment. Retry the same order.", 502);
    return cashfreeResponse(await reconcile(order, remote));
  }

  async function resume(identity, userId) {
    const order = await read(identity.id);
    if (!order) return null;
    assertLive(order);
    if (String(order.user) !== String(userId) || order.checkoutFingerprint !== identity.fingerprint) {
      fail("CHECKOUT_CHANGED", "This payment reference belongs to a different checkout. Check your orders first.");
    }
    return session(order);
  }

  async function create(identity, snapshot, phone) {
    client.requireConfigured();
    if (!Number.isFinite(snapshot.totalAmount) || snapshot.totalAmount < 1) fail("INVALID_AMOUNT", "Minimum online payment is Rs 1.", 400);
    let order;
    try {
      order = await Order.findOneAndUpdate({ _id: identity.id }, { $setOnInsert: {
        ...snapshot, paymentProvider: "cashfree", cashfreeEnvironment: "production",
        cashfreeOrderId: `cc_${identity.id}`, cashfreeCustomerPhone: phone,
        checkoutFingerprint: identity.fingerprint,
      } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }).select(secretFields);
    } catch (error) {
      if (error.code !== 11000) throw error;
      order = await read(identity.id);
    }
    if (order.checkoutFingerprint !== identity.fingerprint || String(order.user) !== String(snapshot.user)) {
      fail("CHECKOUT_CHANGED", "Payment reference already used. Check your orders.");
    }
    return session(order);
  }

  async function cancel(order) {
    assertLive(order);
    const cancelled = await Order.findOneAndUpdate({ _id: order._id, orderStatus: { $in: ["PLACED", "CONFIRMED"] } }, {
      $set: { orderStatus: "CANCELLED" },
      $push: { statusTimeline: { status: "CANCELLED", time: new Date() } },
    }, { new: true });
    if (!cancelled && order.orderStatus !== "CANCELLED") fail("CANNOT_CANCEL", "This order can no longer be cancelled.");
    if (cancelled) await onCancelled(cancelled).catch(() => logger.error("Cashfree cancellation notification failed", { orderId: String(order._id) }));
    // Keep cancellation saved even if Cashfree is offline; the worker/webhook retries.
    try { await reconcile(await read(order._id)); }
    catch { logger.error("Cashfree cancellation reconciliation pending", { orderId: String(order._id) }); }
    return read(order._id);
  }

  async function sweep() {
    try { client.requireConfigured(); } catch { return; }
    const orders = await Order.find({ paymentProvider: "cashfree", $or: [
      { paymentStatus: "PENDING" },
      { paymentStatus: "PAID", orderStatus: "CANCELLED", refundStatus: { $nin: terminalRefundStates } },
    ] }).select(secretFields).sort({ paymentCheckedAt: 1, createdAt: 1 }).limit(20);
    for (const order of orders) {
      await Order.updateOne({ _id: order._id }, { $set: { paymentCheckedAt: new Date() } });
      try { await reconcile(order); }
      catch (error) {
        // Only a provider-confirmed missing order may expire a never-created session.
        if (error.upstreamStatus === 404 && !order.cashfreeSessionId && Date.now() - new Date(order.createdAt).getTime() > 35 * 60_000) {
          await Order.updateOne({ _id: order._id, paymentStatus: "PENDING" }, { $set: { paymentStatus: "FAILED", orderStatus: "CANCELLED" } });
        } else logger.error("Cashfree reconciliation retry pending", { orderId: String(order._id), code: error.code || "UNAVAILABLE" });
      }
    }
  }
  return { owned, resume, create, session, reconcile, cancel, sweep, response: cashfreeResponse };
}
