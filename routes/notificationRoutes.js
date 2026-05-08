import express from "express";
import DeviceToken from "../models/DeviceToken.js";
import { authenticateToken } from "./auth.js";

const router = express.Router();

/**
 * POST /api/notifications/device-token
 * Body: { token, platform }
 * Auth: user
 */
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

/**
 * DELETE /api/notifications/device-token
 * Body: { token }
 * Auth: user
 */
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

export default router;
