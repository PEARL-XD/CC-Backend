import express from "express";
import crypto from "crypto";
import { razorpay } from "../config/razorpay.js";
import { Order } from "../models/Order.js";
import Item from "../models/Item.js";
import { authenticateToken } from "./auth.js";

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

/* ---------------- ROUTES ---------------- */

/**
 * POST /api/orders/create
 * Body: { cartItems: [{ _id, quantity, selectedSize }], schedule?: string }
 * Auth: user
 *
 * Prices are fetched from the DB — never trusted from the client.
 */
router.post("/orders/create", authenticateToken, async (req, res) => {
  try {
    const { cartItems, schedule } = req.body;
    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    // Fetch all products in one query
    const productIds = cartItems.map((i) => i._id);
    const products = await Item.find({ _id: { $in: productIds } }).lean();
    const productMap = Object.fromEntries(products.map((p) => [p._id.toString(), p]));

    // Validate every item and build the verified order items array
    const verifiedItems = [];
    for (const item of cartItems) {
      const product = productMap[item._id?.toString()];
      if (!product) {
        return res.status(400).json({ error: `Product not found: ${item._id}` });
      }
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        return res.status(400).json({ error: `Invalid quantity for ${product.name}` });
      }
      verifiedItems.push({
        _id: product._id,
        name: product.name,       // ← from DB
        img: product.imgUrl,         // ← from DB
        price: product.price,     // ← from DB, never item.price
        selectedSize: Number(item.selectedSize),
        quantity,
      });
    }

    // Calculate total server-side from verified prices
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
      statusTimeline: [{ status: "PLACED", time: new Date() }],
    });

    res.json({
      success: true,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      amount: amountInPaise,
      currency: "INR",
      razorpayOrderId: razorpayOrder.id,
      localOrderId: order._id,
    });
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ error: "Failed to create order" });
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

    if (!localOrderId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment details" });
    }

    const order = await Order.findById(localOrderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Ownership check — prevent one user verifying another user's order
    if (order.user.toString() !== req.user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Idempotency guard — don't process an already-paid order twice
    if (order.paymentStatus === "PAID") {
      return res.status(409).json({ error: "Order already verified" });
    }

    // Verify Razorpay signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      order.paymentStatus = "FAILED";
      await order.save();
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    order.paymentStatus = "PAID";
    order.orderStatus = "CONFIRMED";
    order.statusTimeline.push({ status: "CONFIRMED", time: new Date() });
    await order.save();

    res.json({ success: true, message: "Payment verified", order });
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({ error: "Failed to verify payment" });
  }
});

/**
 * GET /api/orders/me
 * Auth: user
 */
router.get("/orders/me", authenticateToken, async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user.id }).sort({ createdAt: -1 });
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
      .populate("user", "name phone email tower flat")
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
router.patch("/admin/orders/:id/status", authenticateToken, async (req, res) => {
  try {
    if (!(await isAdmin(req))) {
      return res.status(403).json({ error: "Admin access only" });
    }

    const { status } = req.body;
    const allowed = ["PLACED", "CONFIRMED", "PACKED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"];

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    // Single null check, in the right place — before any mutations
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    order.orderStatus = status;
    order.statusTimeline.push({ status, time: new Date() });
    await order.save();

    res.json({ success: true, order });
  } catch (err) {
    console.error("Update order status error:", err);
    res.status(500).json({ error: "Failed to update order status" });
  }
});

export default router;