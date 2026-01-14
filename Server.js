import dotenv from "dotenv";
dotenv.config();
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import cookieParser from "cookie-parser";
import fs from "fs";
import https from "https";
import http from "http";
import path from "path";
import helmet from "helmet";
import authRouter from "./routes/auth.js";
import itemsRouter from "./routes/itemsRoutes.js";
import cron from "node-cron"
import RefreshToken from "./models/RefreshToken.js";
import cartRoutes from "./routes/cartRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
// Schedule cleanup to run every day at midnight
// Schedule cleanup to run every MINUTE in development
cron.schedule("* * * * *", async () => {
  try {
    const result = await RefreshToken.deleteMany({
      $or: [
        { revoked: true },
        { expiresAt: { $lte: new Date() } }
      ]
    });
    console.log(`Cron job: Deleted ${result.deletedCount} expired/revoked tokens.`);
  } catch (error) {
    console.error("Error during cron token cleanup:", error);
  }
});

const app = express();
// Redirect HTTP to HTTPS middleware
app.set("trust proxy", 1);
app.use(helmet());
app.use(cookieParser());

app.use(
  cors({
    origin: ["https://localhost:5173","https://192.168.1.10:5173" , "https://nondisastrous-floggable-maisie.ngrok-free.dev"], // allow localhost and mobile IP
    credentials: true,
  })
);

app.use(express.json());

const MONGO_URI = process.env.MONGO_URI;

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected."))
  .catch((err) => console.error("MongoDB connection error:", err));

app.use("/api", authRouter);
app.use("/api", itemsRouter);
app.use("/api", cartRoutes);
app.use("/api", orderRoutes);

app.get("/", (req, res) => {
  res.send("Hello from CleanCuts backend!");
});

// Load SSL certificates for HTTPS
const __dirname = path.resolve();
const privateKey = fs.readFileSync(
  path.join(__dirname, "./security/cert.key"),
  "utf8"
);
const certificate = fs.readFileSync(
  path.join(__dirname, "./security/cert.pem"),
  "utf8"
);
const credentials = { key: privateKey, cert: certificate };

// app.use((req, res, next) => {
//   if (req.secure || process.env.NODE_ENV !== "production") {
//     next();
//   } else {
//     res.redirect("https://" + req.headers.host + req.url);
//   }
// });

const HTTPS_PORT = process.env.HTTPS_PORT || 3443; // non standard 443 here for local testing
const HTTP_PORT = process.env.HTTP_PORT || 3080; // available http port

// Create HTTPS Server
const httpsServer = https.createServer(credentials, app);
// Create HTTP Server (to redirect)
const httpServer = http.createServer(app);

// Listen on HTTPS and HTTP ports
httpsServer.listen(HTTPS_PORT, () =>
  console.log(`✅ HTTPS Server running on https://localhost:${HTTPS_PORT}`)
);
httpServer.listen(HTTP_PORT, () =>
  console.log(
    `HTTP Server running on http://localhost:${HTTP_PORT} and redirecting to HTTPS`
  )
);
