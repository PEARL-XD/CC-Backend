import express from "express";
import User from "../models/User.js";
import Coupon from "../models/Coupon.js";
import { authenticateToken } from "./auth.js";
import {
  generateCouponCode,
  validateCouponForUser,
} from "../utils/coupons.js";

const router = express.Router();

const isAdmin = async (req) => {
  const user = await User.findById(req.user.id).select("role").lean();
  return user?.role === "admin";
};

function normalizeCodeInput(value = "") {
  return String(value).trim().toUpperCase().replace(/\s+/g, "");
}

router.post("/coupons/validate", authenticateToken, async (req, res) => {
  try {
    const code = String(req.body.code || "").trim();
    const subtotalAmount = Number(req.body.subtotalAmount || 0);

    const result = await validateCouponForUser({
      code,
      userId: req.user.id,
      subtotalAmount,
    });

    if (!result.ok) {
      return res.status(result.statusCode).json({ error: result.error });
    }

    return res.json({
      success: true,
      coupon: {
        code: result.coupon.code,
        title: result.coupon.title || "",
        description: result.coupon.description || "",
        discountType: result.coupon.discountType,
        value: Number(result.coupon.value) || 0,
        minOrderAmount: Number(result.coupon.minOrderAmount) || 0,
      },
      discountAmount: result.discountAmount,
      finalSubtotal: result.finalSubtotal,
    });
  } catch (error) {
    console.error("Coupon validation error:", error);
    return res.status(500).json({ error: "Failed to validate coupon." });
  }
});

router.get("/admin/coupons", authenticateToken, async (req, res) => {
  try {
    if (!(await isAdmin(req))) {
      return res.status(403).json({ error: "Admin access only" });
    }

    const coupons = await Coupon.find()
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      coupons,
    });
  } catch (error) {
    console.error("List coupons error:", error);
    return res.status(500).json({ error: "Failed to list coupons." });
  }
});

router.post("/admin/coupons", authenticateToken, async (req, res) => {
  try {
    if (!(await isAdmin(req))) {
      return res.status(403).json({ error: "Admin access only" });
    }

    const code = normalizeCodeInput(req.body.code || generateCouponCode());
    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();
    const discountType = String(req.body.discountType || "percent")
      .trim()
      .toLowerCase();
    const value = Number(req.body.value);
    const minOrderAmount = Number(req.body.minOrderAmount || 0);
    const active = req.body.active !== false;
    const startsAt = req.body.startsAt ? new Date(req.body.startsAt) : undefined;
    const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : undefined;

    if (!["percent", "flat"].includes(discountType)) {
      return res.status(400).json({
        error: "discountType must be percent or flat",
      });
    }

    if (!Number.isFinite(value) || value < 0) {
      return res.status(400).json({
        error: "value must be a valid number",
      });
    }

    if (!Number.isFinite(minOrderAmount) || minOrderAmount < 0) {
      return res.status(400).json({
        error: "minOrderAmount must be a valid number",
      });
    }

    if (startsAt && Number.isNaN(startsAt.getTime())) {
      return res.status(400).json({ error: "startsAt is invalid" });
    }

    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return res.status(400).json({ error: "expiresAt is invalid" });
    }

    const coupon = await Coupon.create({
      code,
      title,
      description,
      discountType,
      value,
      minOrderAmount,
      active,
      startsAt,
      expiresAt,
    });

    return res.json({
      success: true,
      coupon,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ error: "Coupon code already exists." });
    }

    console.error("Create coupon error:", error);
    return res.status(500).json({ error: "Failed to create coupon." });
  }
});

export default router;
