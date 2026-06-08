import express from "express";
import mongoose from "mongoose";
import Item from "../models/Item.js";
import StorefrontSettings from "../models/StorefrontSettings.js";
import User from "../models/User.js";
import { authenticateToken } from "./auth.js";
import { clearItemsCache } from "./itemsRoutes.js";

const router = express.Router();

const STOREFRONT_KEY = "storefront";

const isAdmin = async (req) => {
  const user = await User.findById(req.user.id).select("role").lean();
  return user?.role === "admin";
};

const requireAdmin = async (req, res, next) => {
  try {
    if (!(await isAdmin(req))) {
      return res.status(403).json({ error: "Admin access only" });
    }
    return next();
  } catch (err) {
    console.error("Admin check error:", err);
    return res.status(500).json({ error: "Failed to verify admin access" });
  }
};

async function getOrCreateStorefrontSettings() {
  return StorefrontSettings.findOneAndUpdate(
    { key: STOREFRONT_KEY },
    {
      $setOnInsert: {
        key: STOREFRONT_KEY,
        cookedEnabled: true,
        storeOpen: true,
      },
    },
    { upsert: true, new: true }
  ).lean();
}

router.use("/admin", authenticateToken, requireAdmin);

router.get("/admin/inventory", async (req, res) => {
  try {
    const settings = await getOrCreateStorefrontSettings();

    const items = await Item.find()
      .select(
        "_id category name desc price oldprice imgUrl isOutOfStock createdAt updatedAt"
      )
      .sort({ category: 1, name: 1 })
      .lean();

    return res.json({
      settings: {
        cookedEnabled: settings?.cookedEnabled ?? true,
        storeOpen: settings?.storeOpen ?? true,
      },
      items,
    });
  } catch (err) {
    console.error("GET /api/admin/inventory error:", err);
    return res.status(500).json({ error: "Failed to load inventory" });
  }
});

router.patch("/admin/storefront", async (req, res) => {
  try {
    const cookedEnabled = req.body.cookedEnabled;
    const storeOpen = req.body.storeOpen;
    const updates = { key: STOREFRONT_KEY };

    if ("cookedEnabled" in req.body) {
      if (typeof cookedEnabled !== "boolean") {
        return res.status(400).json({
          error: "cookedEnabled must be true or false",
        });
      }
      updates.cookedEnabled = cookedEnabled;
    }

    if ("storeOpen" in req.body) {
      if (typeof storeOpen !== "boolean") {
        return res.status(400).json({
          error: "storeOpen must be true or false",
        });
      }
      updates.storeOpen = storeOpen;
    }

    if (!("cookedEnabled" in updates) && !("storeOpen" in updates)) {
      return res.status(400).json({
        error: "No storefront setting provided",
      });
    }

    const settings = await StorefrontSettings.findOneAndUpdate(
      { key: STOREFRONT_KEY },
      { $set: updates },
      { upsert: true, new: true }
    ).lean();

    clearItemsCache();

    return res.json({
      success: true,
      settings: {
        cookedEnabled: settings.cookedEnabled,
        storeOpen: settings.storeOpen,
      },
    });
  } catch (err) {
    console.error("PATCH /api/admin/storefront error:", err);
    return res.status(500).json({ error: "Failed to update storefront" });
  }
});

router.patch("/admin/items/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid item id" });
    }

    const updates = {};

    if ("isOutOfStock" in req.body) {
      if (typeof req.body.isOutOfStock !== "boolean") {
        return res.status(400).json({
          error: "isOutOfStock must be true or false",
        });
      }
      updates.isOutOfStock = req.body.isOutOfStock;
    }

    if ("price" in req.body) {
      const price = Number(req.body.price);
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: "Invalid price" });
      }
      updates.price = price;
    }

    if ("oldprice" in req.body) {
      if (req.body.oldprice === null || req.body.oldprice === "") {
        updates.oldprice = undefined;
      } else {
        const oldprice = Number(req.body.oldprice);
        if (!Number.isFinite(oldprice) || oldprice < 0) {
          return res.status(400).json({ error: "Invalid old price" });
        }
        updates.oldprice = oldprice;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const item = await Item.findByIdAndUpdate(
      id,
      { $set: updates },
      {
        new: true,
        runValidators: true,
      }
    )
      .select("_id category name desc price oldprice imgUrl isOutOfStock")
      .lean();

    if (!item) return res.status(404).json({ error: "Item not found" });

    clearItemsCache();

    return res.json({
      success: true,
      item,
    });
  } catch (err) {
    console.error("PATCH /api/admin/items/:id error:", err);
    return res.status(500).json({ error: "Failed to update item" });
  }
});

export default router;
