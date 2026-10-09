import mongoose from "mongoose";

// Sandbox payments never enter the live Order collection or fulfillment pipeline.
const schema = new mongoose.Schema({
  _id: { type: String, required: true, maxlength: 45 },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  idempotencyKey: { type: String, required: true },
  customerPhone: { type: String, required: true },
  amountPaise: { type: Number, required: true, default: 100 },
  currency: { type: String, enum: ["INR"], default: "INR" },
  environment: { type: String, enum: ["sandbox"], default: "sandbox" },
  status: {
    type: String,
    enum: ["CREATING", "ACTIVE", "PAID", "EXPIRED", "TERMINATED", "TERMINATION_REQUESTED"],
    default: "CREATING",
  },
  paymentSessionId: { type: String, default: "" },
}, { timestamps: true, collection: "cashfree_sandbox_orders" });

export default mongoose.model("CashfreeSandboxOrder", schema);
