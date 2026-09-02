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
   CORS (adjust origin later)
======================= */

app.use(
  cors({
    origin: ["https://localhost:5173","https://192.168.1.9:5173/","https://192.168.1.9:5173","https://cc-frontend-mhbl.onrender.com","https://cleanchops.in"],// frontend local (change later to prod)
    credentials: true,
  })
);
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});
/* =======================
   DATABASE
======================= */

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
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
