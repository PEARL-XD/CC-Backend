import express from "express";
import DeviceToken from "../models/DeviceToken.js";
import NotificationReceipt from "../models/NotificationReceipt.js";
import User from "../models/User.js";
import { authenticateToken } from "./auth.js";
import { sendPromoBroadcast } from "../utils/pushNotifications.js";

const router = express.Router();

const isAdmin = async (req) => {
  const user = await User.findById(req.user.id).select("role").lean();
  return user?.role === "admin";
};

router.post("/notifications/device-token", authenticateToken, async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    const platform = String(req.body.platform || "").trim().toLowerCase();

    if (!token) {
      return res.status(400).json({ error: "Device token is required." });
    }

    if (!["android", "ios"].includes(platform)) {
      return res.status(400).json({ error: "Platform must be android or ios." });
    }

    await DeviceToken.findOneAndUpdate(
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

router.post("/notifications/ack", authenticateToken, async (req, res) => {
  try {
    const notificationId = String(req.body.notificationId || "").trim();
    const token = String(req.body.token || "").trim();
    const event = String(req.body.event || "").trim().toUpperCase();
    const route = String(req.body.route || "").trim();
    const title = String(req.body.title || "").trim();
    const body = String(req.body.body || "").trim();

    if (!notificationId || !token) {
      return res.status(400).json({
        error: "notificationId and token are required.",
      });
    }

    if (!["RECEIVED", "OPENED"].includes(event)) {
      return res.status(400).json({ error: "Invalid notification event." });
    }

    const device = await DeviceToken.findOne({
      user: req.user.id,
      token,
    })
      .select("platform")
      .lean();

    if (!device) {
      return res.status(404).json({ error: "Device token not found." });
    }

    const existing = await NotificationReceipt.findOneAndUpdate(
      { notificationId, token },
      {
        $setOnInsert: {
          notificationId,
          user: req.user.id,
          token,
          platform: device.platform,
          type: String(req.body.type || "broadcast").trim().toLowerCase() || "broadcast",
          route: route || "/home",
          title,
          body,
          status: "SENT",
          sentAt: new Date(),
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      },
    );

    const nextStatus = event === "OPENED" ? "OPENED" : existing.status === "OPENED" ? "OPENED" : "RECEIVED";

    existing.status = nextStatus;
    if (nextStatus === "RECEIVED" && !existing.receivedAt) {
      existing.receivedAt = new Date();
    }
    if (nextStatus === "OPENED" && !existing.openedAt) {
      existing.openedAt = new Date();
      if (!existing.receivedAt) {
        existing.receivedAt = existing.openedAt;
      }
    }

    existing.lastSeenAt = new Date();
    await existing.save();

    return res.json({ success: true });
  } catch (error) {
    console.error("Notification ack error:", error);
    return res.status(500).json({ error: "Failed to acknowledge notification." });
  }
});

router.post("/admin/notifications/broadcast", authenticateToken, async (req, res) => {
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

router.get(
  "/admin/notifications/broadcast/:notificationId/stats",
  authenticateToken,
  async (req, res) => {
    try {
      if (!(await isAdmin(req))) {
        return res.status(403).json({ error: "Admin access only" });
      }

      const notificationId = String(req.params.notificationId || "").trim();
      if (!notificationId) {
        return res.status(400).json({ error: "notificationId is required." });
      }

      const [targetedDevices, receivedDevices, openedDevices] = await Promise.all([
        NotificationReceipt.countDocuments({ notificationId }),
        NotificationReceipt.countDocuments({
          notificationId,
          status: { $in: ["RECEIVED", "OPENED"] },
        }),
        NotificationReceipt.countDocuments({
          notificationId,
          status: "OPENED",
        }),
      ]);

      return res.json({
        success: true,
        notificationId,
        stats: {
          targetedDevices,
          receivedDevices,
          openedDevices,
          pendingDevices: Math.max(targetedDevices - receivedDevices, 0),
        },
      });
    } catch (error) {
      console.error("Broadcast stats error:", error);
      return res.status(500).json({ error: "Failed to load broadcast stats." });
    }
  },
);

export default router;
