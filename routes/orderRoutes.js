import express from "express";
import crypto from "crypto";
import { razorpay } from "../config/razorpay.js";
import { Order } from "../models/Order.js";
import { authenticateToken } from "./auth.js"; 

const router = express.Router();

/**
 * POST /api/orders/create
 * Body: { cartItems: [...], schedule?: string }
 * Auth: user
 */
router.post("/orders/create", authenticateToken, async (req, res) => {
  try {
    const { cartItems, schedule } = req.body;
    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    // Calculate total in INR based on incoming cart
    const totalAmount = cartItems.reduce(
      (sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0),
      0
    );

    if (totalAmount <= 0) {
      return res.status(400).json({ error: "Invalid order amount" });
    }

    const amountInPaise = Math.round(totalAmount * 100);

    // Create Razorpay order
    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
    });

    // Create local order document
    const order = await Order.create({
      user: req.user.id, // from authenticateToken payload (id + phone)
      items: cartItems.map((item) => ({
        _id: item._id,
        name: item.name,
        img: item.img,
        price: Number(item.price),
        selectedSize: Number(item.selectedSize),
        quantity: Number(item.quantity),
      })),
      schedule,
      totalAmount,
      razorpayOrderId: razorpayOrder.id,
      paymentStatus: "PENDING",
      orderStatus: "PLACED",
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
 * Auth: user
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

    // Verify signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      order.paymentStatus = "FAILED";
      await order.save();
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    order.paymentStatus = "PAID";
    order.orderStatus = "CONFIRMED";
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
 * Simple admin check helper
 * For now: treat one specific user as admin (by phone or id).
 * Later you can switch to a proper role field on User.
 */
const isAdmin = (req) => {
  // easiest: set ADMIN_PHONE in .env and compare
  const adminPhone = process.env.ADMIN_PHONE;
  return adminPhone && req.user?.phone && req.user.phone.toString() === adminPhone.toString();
};

/**
 * GET /api/admin/orders
 * Auth: admin
 */
router.get("/admin/orders", authenticateToken, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access only" });
    }

    const orders = await Order.find()
      .populate("user", "name phone email")
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
 * Auth: admin
 */
router.patch("/admin/orders/:id/status", authenticateToken, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Admin access only" });
    }

    const { status } = req.body;
    const allowed = ["PLACED", "CONFIRMED", "PACKED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"];

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { orderStatus: status },
      { new: true }
    );

    if (!order) return res.status(404).json({ error: "Order not found" });

    res.json({ success: true, order });
  } catch (err) {
    console.error("Update order status error:", err);
    res.status(500).json({ error: "Failed to update order status" });
  }
});

export default router;
