import express from "express";
import jwt from "jsonwebtoken";
import AppOpenAnonymousDaily from "../models/AppOpenAnonymousDaily.js";
import DeviceToken from "../models/DeviceToken.js";
import AppOpenDaily from "../models/AppOpenDaily.js";
import NotificationReceipt from "../models/NotificationReceipt.js";
import User from "../models/User.js";
import { authenticateToken } from "./auth.js";
import {
  sendPromoBroadcast,
  sendTargetedPromoNotification,
} from "../utils/pushNotifications.js";

const router = express.Router();

const isAdmin = async (req) => {
  const user = await User.findById(req.user.id).select("role").lean();
  return user?.role === "admin";
};

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePhone(value = "") {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) {
    return digits.slice(2);
  }
  return digits;
}

function getOptionalUserId(req) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];

  if (!token || !process.env.ACCESS_TOKEN_SECRET) {
    return null;
  }

  try {
    const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    return payload?.id || null;
  } catch (_) {
    return null;
  }
}

function getIstDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value || "0000";
  const month = parts.find((part) => part.type === "month")?.value || "00";
  const day = parts.find((part) => part.type === "day")?.value || "00";

  return `${year}-${month}-${day}`;
}

router.post("/app-opens/track", authenticateToken, async (req, res) => {
  try {
    const now = new Date();
    const dateKey = getIstDateKey(now);

    const doc = await AppOpenDaily.findOneAndUpdate(
      {
        user: req.user.id,
        dateKey,
      },
      {
        $inc: { openCount: 1 },
        $set: {
          lastOpenedAt: now,
        },
        $setOnInsert: {
          user: req.user.id,
          dateKey,
          firstOpenedAt: now,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      },
    ).populate("user", "name phone society tower flat");

    return res.json({
      success: true,
      dateKey,
      loggedInOpenCount: doc.openCount,
      openCount: doc.openCount,
    });
  } catch (error) {
    console.error("App open track error:", error);
    return res.status(500).json({ error: "Failed to track app open." });
  }
});

router.post("/app-opens/track-anonymous", async (req, res) => {
  try {
    const now = new Date();
    const dateKey = getIstDateKey(now);

    const doc = await AppOpenAnonymousDaily.findOneAndUpdate(
      { dateKey },
      {
        $inc: { openCount: 1 },
        $set: {
          lastOpenedAt: now,
        },
        $setOnInsert: {
          dateKey,
          firstOpenedAt: now,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      },
    );

    return res.json({
      success: true,
      dateKey,
      openCount: doc.openCount,
    });
  } catch (error) {
    console.error("Anonymous app open track error:", error);
    return res.status(500).json({ error: "Failed to track anonymous app open." });
  }
});

router.post("/notifications/device-token", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    const platform = String(req.body.platform || "").trim().toLowerCase();
    const userId = getOptionalUserId(req);

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
          user: userId,
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

    return res.json({
      success: true,
      message: "Device token saved.",
      mode: userId ? "linked" : "guest",
    });
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
    const targetType = String(req.body.targetType || "all").trim().toLowerCase();
    const target = String(req.body.target || "").trim();

    console.log("Admin broadcast requested", {
      targetType,
      targetPreview: target.length > 32 ? `${target.slice(0, 32)}...` : target,
      route,
    });

    if (!title || !body) {
      return res.status(400).json({ error: "Title and body are required." });
    }

    let result;

    if (targetType === "all") {
      result = await sendPromoBroadcast({ title, body, route });
    } else {
      let users = [];
      if (targetType === "single") {
        if (!target) {
          return res.status(400).json({
            error: "Target phone or user id is required for single-user sends.",
          });
        }
        const normalizedPhone = normalizePhone(target);
        const lookup = {
          $or: [],
        };
        if (normalizedPhone) {
          lookup.$or.push({ phone: normalizedPhone });
          lookup.$or.push({ phone: target });
        }
        if (/^[a-f\d]{24}$/i.test(target)) {
          lookup.$or.push({ _id: target });
        }

        users = await User.find(lookup)
          .select("_id name phone society tower floor flat")
          .lean();

        console.log("Single-user broadcast resolved", {
          matchedUsers: users.length,
          matchedUserIds: users.map((user) => user._id?.toString?.()).filter(Boolean),
        });

        if (!users.length) {
          return res.status(404).json({
            error: "No user found for the provided phone or user id.",
          });
        }
      } else if (targetType === "society") {
        if (!target) {
          return res.status(400).json({
            error: "Society is required for society targeting.",
          });
        }
        users = await User.find({
          society: new RegExp(`^${escapeRegex(target)}$`, "i"),
        })
          .select("_id name phone society tower floor flat")
          .lean();
        console.log("Society broadcast resolved", {
          matchedUsers: users.length,
          target,
        });
      } else if (targetType === "tower") {
        if (!target) {
          return res.status(400).json({
            error: "Tower is required for tower targeting.",
          });
        }
        users = await User.find({
          tower: new RegExp(`^${escapeRegex(target)}$`, "i"),
        })
          .select("_id name phone society tower floor flat")
          .lean();
        console.log("Tower broadcast resolved", {
          matchedUsers: users.length,
          target,
        });
      } else if (targetType === "floor") {
        if (!target) {
          return res.status(400).json({
            error: "Floor is required for floor targeting.",
          });
        }
        users = await User.find({
          floor: new RegExp(`^${escapeRegex(target)}$`, "i"),
        })
          .select("_id name phone society tower floor flat")
          .lean();
        console.log("Floor broadcast resolved", {
          matchedUsers: users.length,
          target,
        });
      } else {
        return res.status(400).json({
          error: "Invalid targetType. Use all, single, society, tower, or floor.",
        });
      }

      result = await sendTargetedPromoNotification({
        title,
        body,
        route,
        users,
      });
    }

    return res.json({
      success: true,
      message: "Broadcast sent.",
      audience: {
        targetType,
        target: targetType === "all" ? "" : target,
      },
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

router.get("/admin/app-opens/daily", authenticateToken, async (req, res) => {
  try {
    if (!(await isAdmin(req))) {
      return res.status(403).json({ error: "Admin access only" });
    }

    const dateKey = String(req.query.dateKey || getIstDateKey()).trim();
    const [docs, anonymousDoc] = await Promise.all([
      AppOpenDaily.find({ dateKey })
        .populate("user", "name phone society tower flat")
        .sort({ openCount: -1, lastOpenedAt: -1 })
        .lean(),
      AppOpenAnonymousDaily.findOne({ dateKey }).lean(),
    ]);

    const entries = docs.map((doc) => ({
      userId: doc.user?._id?.toString?.() || doc.user?.toString?.() || "",
      name: doc.user?.name || "Unknown",
      phone: doc.user?.phone || "",
      society: doc.user?.society || "",
      tower: doc.user?.tower || "",
      flat: doc.user?.flat || "",
      openCount: doc.openCount || 0,
      firstOpenedAt: doc.firstOpenedAt || null,
      lastOpenedAt: doc.lastOpenedAt || null,
    }));

    const totalOpens = entries.reduce((sum, entry) => sum + entry.openCount, 0);

    return res.json({
      success: true,
      dateKey,
      anonymousOpenCount: anonymousDoc?.openCount || 0,
      loggedInOpenCount: totalOpens,
      totalAppOpens: totalOpens + (anonymousDoc?.openCount || 0),
      totalOpens,
      uniqueUsers: entries.length,
      entries,
    });
  } catch (error) {
    console.error("Daily app opens fetch error:", error);
    return res.status(500).json({ error: "Failed to load app open stats." });
  }
});

export default router;
