// backend/models/Order.js
import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // product id
    name: { type: String, required: true },
    img: { type: String },
    price: { type: Number, required: true }, // final price per item
    selectedSize: { type: Number, required: true }, // grams
    quantity: { type: Number, required: true },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    items: { type: [orderItemSchema], required: true },
    schedule: { type: String }, // e.g. "Evening 6-8 PM"
    totalAmount: { type: Number, required: true }, // in INR (not paise)
    razorpayOrderId: { type: String },
    paymentStatus: {
      type: String,
      enum: ["PENDING", "PAID", "FAILED"],
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

export const Order = mongoose.model("Order", orderSchema);
