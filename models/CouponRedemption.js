import mongoose from "mongoose";

const couponRedemptionSchema = new mongoose.Schema(
  {
    coupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      required: true,
    },
    couponCode: { type: String, required: true },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    discountAmount: { type: Number, default: 0 },
    redeemedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

couponRedemptionSchema.index({ coupon: 1, user: 1 }, { unique: true });

const CouponRedemption = mongoose.model(
  "CouponRedemption",
  couponRedemptionSchema,
);

export default CouponRedemption;
