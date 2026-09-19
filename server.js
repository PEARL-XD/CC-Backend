import dotenv from "dotenv";
dotenv.config();

import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import cron from "node-cron";

import authRouter from "./routes/auth.js";
import itemsRouter from "./routes/itemsRoutes.js";
import cartRoutes from "./routes/cartRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import RefreshToken from "./models/RefreshToken.js";
import supportRoutes from "./routes/support.js";
import adminInventoryRoutes from "./routes/adminInventoryRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import couponRoutes from "./routes/couponRoutes.js";
import StorefrontSettings from "./models/StorefrontSettings.js";
import User from "./models/User.js";
import { clearStorefrontSettingsCache } from "./utils/storefrontSettingsCache.js";
const app = express();

/* =======================
   BASIC APP SETUP
======================= */

app.set("trust proxy", 1); // REQUIRED for Render / Railway / VPS

app.use(helmet());
app.use(cookieParser());
// API requests contain references and addresses, not uploaded files. Keep the
// body bounded so malformed clients cannot allocate excessive memory.
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

/* =======================
   CORS
======================= */

const normalizeOrigin = (value = "") => value.trim().replace(/\/$/, "");
const configuredFrontendOrigins = String(process.env.FRONTEND_URLS || "")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

const allowedFrontendOrigins = new Set([
  "https://localhost:5173",
  "http://localhost:5173",
  "https://192.168.1.9:5173",
  "http://192.168.1.9:5173",
  "https://192.168.1.10:5173",
  "http://192.168.1.10:5173",
  "https://cc-frontend-mhbl.onrender.com",
  "https://cleanchops.in",
  ...configuredFrontendOrigins,
]);

app.use(
  cors({
    origin(origin, callback) {
      // Non-browser requests (health checks, mobile apps, curl) have no origin.
      if (!origin || allowedFrontendOrigins.has(normalizeOrigin(origin))) {
        return callback(null, true);
      }

      console.warn("CORS origin rejected", { origin });
      return callback(new Error("Origin is not allowed by CORS."));
    },
    credentials: true,
  }),
);
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});
/* =======================
   DATABASE
======================= */

async function ensureUserPhoneIndex() {
  const indexes = await User.collection.indexes();
  const phoneIndexes = indexes.filter((index) => index.key?.phone === 1);
  const hasCorrectIndex = phoneIndexes.some(
    (index) => index.unique === true && index.sparse === true,
  );

  if (hasCorrectIndex && phoneIndexes.length === 1) return;

  // Empty phone values are not real phone numbers and would block a sparse
  // unique index if old records stored them as null or an empty string.
  await User.updateMany(
    { $or: [{ phone: null }, { phone: "" }] },
    { $unset: { phone: 1 } },
  );

  for (const index of phoneIndexes) {
    await User.collection.dropIndex(index.name);
  }

  await User.collection.createIndex(
    { phone: 1 },
    { unique: true, sparse: true, name: "phone_1" },
  );
  console.log("✅ User phone index verified as sparse and unique");
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("✅ MongoDB connected");
    try {
      await ensureUserPhoneIndex();
    } catch (error) {
      console.error("❌ User phone index check failed:", error);
    }
  })
  .catch((err) => console.error("❌ MongoDB error:", err));

/* =======================
   ROUTES
======================= */

app.use("/api", authRouter, supportRoutes,itemsRouter,cartRoutes,orderRoutes,adminInventoryRoutes,notificationRoutes,couponRoutes,);
app.get("/", (req, res) => {
  res.send("CleanCuts backend running");
});

/* =======================
   CRON (refresh-token cleanup)
======================= */

cron.schedule("*/13 * * * *", async () => {
  try {
    const result = await RefreshToken.deleteMany({
      $or: [
        { revoked: true },
        { expiresAt: { $lte: new Date() } },
      ],
    });
    console.log(`🧹 Deleted ${result.deletedCount} old refresh tokens`);
  } catch (error) {
    console.error("❌ Cron cleanup error:", error);
  }
});

async function setStoreOpenStatus(storeOpen) {
  const settings = await StorefrontSettings.findOneAndUpdate(
    { key: "storefront" },
    {
      $set: {
        key: "storefront",
        storeOpen,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  ).lean();

  console.log(
    `Store auto-schedule updated storeOpen=${settings?.storeOpen ? "true" : "false"}`,
  );
  clearStorefrontSettingsCache();
}

cron.schedule(
  "45 8 * * *",
  async () => {
    try {
      await setStoreOpenStatus(true);
    } catch (error) {
      console.error("Store open cron error:", error);
    }
  },
  { timezone: "Asia/Kolkata" },
);

cron.schedule(
  "25 21 * * *",
  async () => {
    try {
      await setStoreOpenStatus(false);
    } catch (error) {
      console.error("Store close cron error:", error);
    }
  },
  { timezone: "Asia/Kolkata" },
);

/* =======================
   START SERVER (HTTP ONLY)
======================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port http://localhost:${PORT}`);
});
