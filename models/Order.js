// backend/models/Order.js
import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    img: { type: String },
    category: { type: String },
    cutInstruction: { type: String },
    price: { type: Number, required: true },
    selectedSize: { type: Number, required: true },
    quantity: { type: Number, required: true },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    items: { type: [orderItemSchema], required: true },
    schedule: { type: String },
    paymentMethod: {
      type: String,
      enum: ["ONLINE", "COD"],
      default: "ONLINE",
    },
    couponCode: { type: String },
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon" },
    couponDiscountAmount: { type: Number, default: 0 },
    silentDelivery: {
      type: Boolean,
      default: false,
    },
    // Snapshot the confirmed delivery location for the delivery team.
    deliveryAddress: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    packagingFee: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },
    razorpayOrderId: { type: String },
    // Absent on legacy orders: those continue through Razorpay/COD unchanged.
    paymentProvider: { type: String, enum: ["cashfree", "razorpay"] },
    cashfreeOrderId: String,
    cashfreeEnvironment: { type: String, enum: ["production"] },
    cashfreeCheckoutMethod: { type: String, enum: ["all", "upi", "card", "netbanking"] },
    cashfreeSessionId: { type: String, select: false },
    cashfreeCustomerPhone: { type: String, select: false },
    checkoutFingerprint: { type: String, select: false },
    cashfreeStatus: String,
    paymentCheckedAt: Date,
    refundStatus: { type: String, enum: ["REQUESTED", "PENDING", "PENDING_APPROVAL", "ONHOLD", "SUCCESS", "FAILED", "CANCELLED", "REJECTED"] },
    cashfreeRefundId: String,
    paymentStatus: {
      type: String,
      enum: ["PENDING", "PAID", "FAILED", "CANCELLED"],
      default: "PENDING",
    },
    orderStatus: {
      type: String,
      enum: [
        "PLACED",
        "CONFIRMED",
        "PACKED",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
        "CANCELLED",
      ],
      default: "PLACED",
    },
    statusTimeline: [
      {
        status: String,
        time: Date,
      },
    ],
  },
  { timestamps: true },
);

// Supports the existing GET /orders/me sort without changing stored orders.
orderSchema.index({ user: 1, createdAt: -1 });

export const Order = mongoose.model("Order", orderSchema);
