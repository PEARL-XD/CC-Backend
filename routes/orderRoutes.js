import express from "express";
import crypto from "crypto";
import { razorpay } from "../config/razorpay.js";
import { Order } from "../models/Order.js";
import Item from "../models/Item.js";
import { authenticateToken } from "./auth.js";
import StorefrontSettings from "../models/StorefrontSettings.js";
import { sendPushToUser } from "../utils/pushNotifications.js";

const router = express.Router();

/* ---------------- HELPERS ---------------- */

/**
 * Role-based admin check.
 * Requires a `role` field on your User model (set server-side only).
 * To migrate: add `role: { type: String, enum: ["user","admin"], default: "user" }`
 * to your User schema, then set role:"admin" directly in MongoDB for your admin account.
 *
 * The old phone-based check is replaced because req.user comes from the JWT payload,
 * which a client controls the contents of at registration time.
 */
import User from "../models/User.js";
const isAdmin = async (req) => {
  const user = await User.findById(req.user.id).select("role").lean();
  return user?.role === "admin";
};

const ORDER_STATUS_MESSAGES = {
  PLACED: {
    title: "Order placed",
    body: "We have received your order.",
  },
  CONFIRMED: {
    title: "Order confirmed",
    body: "Your order has been confirmed.",
  },
  PACKED: {
    title: "Order packed",
    body: "Your order is packed and getting ready to leave.",
  },
  OUT_FOR_DELIVERY: {
    title: "Out for delivery",
    body: "Your order is on the way.",
  },
  DELIVERED: {
    title: "Order delivered",
    body: "Your order has been delivered.",
  },
  CANCELLED: {
    title: "Order cancelled",
    body: "Your order has been cancelled.",
  },
};

const sendOrderStatusNotification = async (order, status) => {
  const config = ORDER_STATUS_MESSAGES[status];
  if (!config) return;

  const body =
    status === "DELIVERED" && order.silentDelivery
      ? "Your order has been delivered and left at your door."
      : config.body;

  await sendPushToUser({
    userId: order.user.toString(),
    title: config.title,
    body,
    preferenceType: "order",
    data: {
      type: "order",
      route: "/orders",
      orderId: order._id.toString(),
      orderStatus: status,
    },
  });
};

const cancelOrderForPaymentIssue = async (order, paymentStatus) => {
  order.paymentStatus = paymentStatus;
  order.orderStatus = "CANCELLED";

  const alreadyCancelled = order.statusTimeline?.some(
    (entry) => entry.status === "CANCELLED",
  );

  if (!alreadyCancelled) {
    order.statusTimeline.push({ status: "CANCELLED", time: new Date() });
  }

  await order.save();
  await sendOrderStatusNotification(order, "CANCELLED");
};

/* ---------------- ROUTES ---------------- */

/**
 * POST /api/orders/create
 * Body: { cartItems: [{ _id, quantity, selectedSize }], schedule?: string, silentDelivery?: boolean }
 * Auth: user
 */
router.post("/orders/create", authenticateToken, async (req, res) => {
  try {
    const { cartItems, schedule } = req.body;

    const silentDelivery =
      req.body.silentDelivery === true || req.body.silentDelivery === "true";

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const productIds = cartItems.map((i) => i._id);
    const products = await Item.find({ _id: { $in: productIds } }).lean();

    const settings = await StorefrontSettings.findOne({
      key: "storefront",
    }).lean();

    const cookedEnabled = settings?.cookedEnabled ?? true;

    const productMap = Object.fromEntries(
      products.map((p) => [p._id.toString(), p])
    );

    const verifiedItems = [];

    for (const item of cartItems) {
      const product = productMap[item._id?.toString()];

      if (!product) {
        return res.status(400).json({
          error: `Product not found: ${item._id}`,
        });
      }

      if (product.isOutOfStock === true) {
        return res.status(400).json({
          error: `${product.name} is currently out of stock`,
        });
      }

      const isCooked =
        String(product.category || "").trim().toLowerCase() === "cooked";

      if (isCooked && !cookedEnabled) {
        return res.status(400).json({
          error: "Cooked food is coming soon to your society.",
        });
      }

      const selectedSize = Number(item.selectedSize);
      const quantity = Number(item.quantity);

      if (![250, 500, 750, 1000].includes(selectedSize)) {
        return res.status(400).json({
          error: `Invalid size for ${product.name}`,
        });
      }

      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        return res.status(400).json({
          error: `Invalid quantity for ${product.name}`,
        });
      }

      const unitPrice = (Number(product.price) || 0) * selectedSize / 1000;

      verifiedItems.push({
        _id: product._id,
        name: product.name,
        img: product.imgUrl,
        price: unitPrice,
        selectedSize,
        quantity,
      });
    }

    const totalAmount = verifiedItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    if (totalAmount <= 0) {
      return res.status(400).json({ error: "Invalid order amount" });
    }

    const amountInPaise = Math.round(totalAmount * 100);

    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
    });

    const order = await Order.create({
      user: req.user.id,
      items: verifiedItems,
      schedule,
      totalAmount,
      razorpayOrderId: razorpayOrder.id,
      paymentStatus: "PENDING",
      orderStatus: "PLACED",
      silentDelivery,
      statusTimeline: [{ status: "PLACED", time: new Date() }],
    });

    await sendOrderStatusNotification(order, "PLACED");

    return res.json({
      success: true,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      amount: amountInPaise,
      currency: "INR",
      razorpayOrderId: razorpayOrder.id,
      localOrderId: order._id,
    });
  } catch (err) {
    console.error("Create order error:", err);
    return res.status(500).json({ error: "Failed to create order" });
  }
});


/**
 * POST /api/orders/verify
 * Body: { localOrderId, razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * Auth: user (must own the order)
 */
router.post("/orders/verify", authenticateToken, async (req, res) => {
  try {
    const {
      localOrderId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (
      !localOrderId ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({ error: "Missing payment details" });
    }

    const order = await Order.findById(localOrderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.user.toString() !== req.user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (order.paymentStatus === "PAID") {
      return res.status(409).json({ error: "Order already verified" });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      await cancelOrderForPaymentIssue(order, "FAILED");
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    order.paymentStatus = "PAID";
    order.orderStatus = "CONFIRMED";

    const alreadyConfirmed = order.statusTimeline?.some(
      (entry) => entry.status === "CONFIRMED",
    );

    if (!alreadyConfirmed) {
      order.statusTimeline.push({ status: "CONFIRMED", time: new Date() });
    }

    await order.save();
    await sendOrderStatusNotification(order, "CONFIRMED");

    res.json({ success: true, message: "Payment verified", order });
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({ error: "Failed to verify payment" });
  }
});
// Added a new route for failed/dismissed payments
router.post("/orders/payment-failed", authenticateToken, async (req, res) => {
  try {
    const { localOrderId, paymentStatus } = req.body;

    if (!localOrderId) {
      return res.status(400).json({ error: "localOrderId is required" });
    }

    const allowedStatuses = ["FAILED", "CANCELLED"];
    const finalPaymentStatus = allowedStatuses.includes(paymentStatus)
      ? paymentStatus
      : "FAILED";

    const order = await Order.findById(localOrderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (order.user.toString() !== req.user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (order.paymentStatus === "PAID") {
      return res.status(409).json({ error: "Paid orders cannot be cancelled" });
    }

    await cancelOrderForPaymentIssue(order, finalPaymentStatus);

    res.json({
      success: true,
      message: `Order marked as ${finalPaymentStatus}`,
      order,
    });
  } catch (err) {
    console.error("Payment failure update error:", err);
    res.status(500).json({ error: "Failed to update payment status" });
  }
});

/**
 * GET /api/orders/me
 * Auth: user
 */
router.get("/orders/me", authenticateToken, async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user.id }).sort({
      createdAt: -1,
    });
    res.json({ orders });
  } catch (err) {
    console.error("Fetch my-orders error:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/**
 * GET /api/admin/orders
 * Auth: admin (role-based)
 */
router.get("/admin/orders", authenticateToken, async (req, res) => {
  try {
    if (!(await isAdmin(req))) {
      return res.status(403).json({ error: "Admin access only" });
    }

    const orders = await Order.find()
      .populate("user", "name phone email society tower flat")
      .sort({ createdAt: -1 });

    res.json({ orders });
  } catch (err) {
    console.error("Admin orders error:", err);
    res.status(500).json({ error: "Failed to fetch admin orders" });
  }
});

/**
 * PATCH /api/admin/orders/:id/status
 * Body: { status }
 * Auth: admin (role-based)
 */
router.patch(
  "/admin/orders/:id/status",
  authenticateToken,
  async (req, res) => {
    try {
      if (!(await isAdmin(req))) {
        return res.status(403).json({ error: "Admin access only" });
      }

      const { status } = req.body;
      const allowed = [
        "PLACED",
        "CONFIRMED",
        "PACKED",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
        "CANCELLED",
      ];

      if (!allowed.includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      // Single null check, in the right place — before any mutations
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: "Order not found" });

      const previousStatus = order.orderStatus;

      order.orderStatus = status;
      order.statusTimeline.push({ status, time: new Date() });
      await order.save();

      if (order.orderStatus !== previousStatus) {
        await sendOrderStatusNotification(order, status);
      }

      res.json({ success: true, order });

    } catch (err) {
      console.error("Update order status error:", err);
      res.status(500).json({ error: "Failed to update order status" });
    }
  },
);

export default router;
