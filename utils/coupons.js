import Coupon from "../models/Coupon.js";
import CouponRedemption from "../models/CouponRedemption.js";

export function normalizeCouponCode(value = "") {
  return String(value).trim().toUpperCase().replace(/\s+/g, "");
}

export function generateCouponCode(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export function calculateCouponDiscount(coupon, subtotalAmount) {
  const subtotal = Math.max(0, Number(subtotalAmount) || 0);
  const rawValue = Math.max(0, Number(coupon?.value) || 0);

  if (!coupon) return 0;

  if (coupon.discountType === "percent") {
    return Math.min(subtotal, Math.round(subtotal * (rawValue / 100) * 100) / 100);
  }

  return Math.min(subtotal, Math.round(rawValue * 100) / 100);
}

export async function validateCouponForUser({
  code,
  userId,
  subtotalAmount,
}) {
  const normalizedCode = normalizeCouponCode(code);

  if (!normalizedCode) {
    return {
      ok: false,
      statusCode: 400,
      error: "Coupon code is required.",
    };
  }

  const coupon = await Coupon.findOne({ code: normalizedCode }).lean();
  if (!coupon || coupon.active !== true) {
    return {
      ok: false,
      statusCode: 404,
      error: "Coupon not found or inactive.",
    };
  }

  const now = new Date();
  if (coupon.startsAt && new Date(coupon.startsAt) > now) {
    return {
      ok: false,
      statusCode: 400,
      error: "This coupon is not active yet.",
    };
  }

  if (coupon.expiresAt && new Date(coupon.expiresAt) < now) {
    return {
      ok: false,
      statusCode: 400,
      error: "This coupon has expired.",
    };
  }

  const alreadyUsed = await CouponRedemption.findOne({
    coupon: coupon._id,
    user: userId,
  }).lean();

  if (alreadyUsed) {
    return {
      ok: false,
      statusCode: 409,
      error: "This coupon has already been used on your account.",
    };
  }

  const subtotal = Math.max(0, Number(subtotalAmount) || 0);
  const minOrderAmount = Math.max(0, Number(coupon.minOrderAmount) || 0);

  if (subtotal < minOrderAmount) {
    const remaining = Math.max(0, minOrderAmount - subtotal);
    return {
      ok: false,
      statusCode: 400,
      error: `Add items worth ₹${remaining.toFixed(2)} more to use this coupon.`,
    };
  }

  const discountAmount = calculateCouponDiscount(coupon, subtotal);

  const finalSubtotal = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);

  return {
    ok: true,
    coupon,
    discountAmount,
    finalSubtotal,
    normalizedCode,
  };
}

export async function redeemCouponForOrder({
  coupon,
  userId,
  orderId,
  discountAmount,
}) {
  if (!coupon || !userId || !orderId) {
    return null;
  }

  return CouponRedemption.findOneAndUpdate(
    {
      coupon: coupon._id,
      user: userId,
    },
    {
      $setOnInsert: {
        coupon: coupon._id,
        couponCode: coupon.code,
        user: userId,
        order: orderId,
        discountAmount: Math.max(0, Number(discountAmount) || 0),
        redeemedAt: new Date(),
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  );
}
