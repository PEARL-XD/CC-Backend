import express from "express";
import DeviceToken from "../models/DeviceToken.js";
import User from "../models/User.js";
import { authenticateToken } from "./auth.js";
import { sendPromoBroadcast } from "../utils/pushNotifications.js";

const router = express.Router();

const isAdmin = async (req) => {
  const user = await User.findById(req.user.id).select("role").lean();
  return user?.role === "admin";
};

router.post("/notifications/device-token", authenticateToken, async (req, res) => {
    console.log("HIT /notifications/device-token", {
    userId: req.user.id,
    phone: req.user.phone,
    body: req.body,
  });

  try {
    const token = String(req.body.token || "").trim();
    const platform = String(req.body.platform || "").trim().toLowerCase();
    console.log("Incoming device token save:", {
  userId: req.user.id,
  phone: req.user.phone,
  platform,
  tokenPreview: token ? `${token.slice(0, 18)}...` : "",
});


    if (!token) {
      return res.status(400).json({ error: "Device token is required." });
    }

    if (!["android", "ios"].includes(platform)) {
      return res.status(400).json({ error: "Platform must be android or ios." });
    }

    const doc = await DeviceToken.findOneAndUpdate(
  { token },
  {
    $set: {
      user: req.user.id,
      token,
      platform,
      lastSeenAt: new Date(),
    },
    $setOnInsert: {
      orderUpdatesEnabled: true,
      promoEnabled: true,
    },
  },
  {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  },
);

console.log("Saved device token:", {
  userId: doc.user?.toString?.() ?? doc.user,
  tokenPreview: token.slice(0, 18) + "...",
  promoEnabled: doc.promoEnabled,
  orderUpdatesEnabled: doc.orderUpdatesEnabled,
});


    return res.json({ success: true, message: "Device token saved." });
  } catch (error) {
    console.error("Save device token error:", error);
    return res.status(500).json({ error: "Failed to save device token." });
  }
});

router.get("/notifications/preferences", authenticateToken, async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();

    if (!token) {
      return res.status(400).json({ error: "Device token is required." });
    }

    const doc = await DeviceToken.findOne({
      user: req.user.id,
      token,
    }).lean();

    return res.json({
      orderUpdatesEnabled: doc?.orderUpdatesEnabled ?? true,
      promoEnabled: doc?.promoEnabled ?? true,
    });
  } catch (error) {
    console.error("Fetch notification preferences error:", error);
    return res.status(500).json({ error: "Failed to fetch preferences." });
  }
});

router.patch("/notifications/preferences", authenticateToken, async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();

    if (!token) {
      return res.status(400).json({ error: "Device token is required." });
    }

    const updates = {};
    if (typeof req.body.orderUpdatesEnabled === "boolean") {
      updates.orderUpdatesEnabled = req.body.orderUpdatesEnabled;
    }
    if (typeof req.body.promoEnabled === "boolean") {
      updates.promoEnabled = req.body.promoEnabled;
    }

    const doc = await DeviceToken.findOneAndUpdate(
      {
        user: req.user.id,
        token,
      },
      {
        ...updates,
        lastSeenAt: new Date(),
      },
      {
        new: true,
      },
    );

    if (!doc) {
      return res.status(404).json({ error: "Device token not found." });
    }

    return res.json({
      success: true,
      preferences: {
        orderUpdatesEnabled: doc.orderUpdatesEnabled,
        promoEnabled: doc.promoEnabled,
      },
    });
  } catch (error) {
    console.error("Update notification preferences error:", error);
    return res.status(500).json({ error: "Failed to update preferences." });
  }
});

router.delete("/notifications/device-token", authenticateToken, async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();

    if (!token) {
      return res.status(400).json({ error: "Device token is required." });
    }

    await DeviceToken.deleteOne({
      user: req.user.id,
      token,
    });

    return res.json({ success: true, message: "Device token removed." });
  } catch (error) {
    console.error("Delete device token error:", error);
    return res.status(500).json({ error: "Failed to remove device token." });
  }
});

router.post("/admin/notifications/broadcast", authenticateToken, async (req, res) => {
  console.log("HIT /admin/notifications/broadcast", {
  userId: req.user.id,
  phone: req.user.phone,
});

  try {
    if (!(await isAdmin(req))) {
      return res.status(403).json({ error: "Admin access only" });
    }

    const title = String(req.body.title || "").trim();
    const body = String(req.body.body || "").trim();
    const route = String(req.body.route || "/home").trim();

    if (!title || !body) {
      return res.status(400).json({ error: "Title and body are required." });
    }

    const result = await sendPromoBroadcast({ title, body, route });

    return res.json({
      success: true,
      message: "Broadcast sent.",
      result,
    });
  } catch (error) {
    console.error("Broadcast notification error:", error);
    return res.status(500).json({ error: "Failed to send broadcast." });
  }
});

export default router;
