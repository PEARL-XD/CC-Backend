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
        user: req.user.id,
        token,
        platform,
        lastSeenAt: new Date(),
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
