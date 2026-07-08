import mongoose from "mongoose";

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    discountType: {
      type: String,
      enum: ["percent", "flat"],
      required: true,
    },
    value: { type: Number, required: true, min: 0 },
    minOrderAmount: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true },
    startsAt: { type: Date },
    expiresAt: { type: Date },
  },
  { timestamps: true },
);

const Coupon = mongoose.model("Coupon", couponSchema);

export default Coupon;
