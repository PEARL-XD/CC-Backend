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

const app = express();

/* =======================
   BASIC APP SETUP
======================= */

app.set("trust proxy", 1); // REQUIRED for Render / Railway / VPS

app.use(helmet());
app.use(cookieParser());
app.use(express.json());

/* =======================
   CORS (adjust origin later)
======================= */

app.use(
  cors({
    origin: ["https://localhost:5173","https://192.168.1.9:5173/","https://192.168.1.9:5173"],// frontend local (change later to prod)
    credentials: true,
  })
);

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

app.use("/api", authRouter);
app.use("/api", itemsRouter);
app.use("/api", cartRoutes);
app.use("/api", orderRoutes);

app.get("/", (req, res) => {
  res.send("CleanCuts backend running");
});

/* =======================
   CRON (refresh-token cleanup)
======================= */

cron.schedule("* * * * *", async () => {
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

/* =======================
   START SERVER (HTTP ONLY)
======================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port http://localhost:${PORT}`);
});
