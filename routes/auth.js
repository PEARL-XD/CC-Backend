import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import User from "../models/User.js";
import RefreshToken from "../models/RefreshToken.js";
import rateLimit from "express-rate-limit";
import { promisify } from "util";
const verifyAsync = promisify(jwt.verify);
// Define limiter for auth routes: e.g., max 5 requests per minute per IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 25,
  message: { error: "Too many requests. Please try again later." },
});
// Middleware to authenticate access token
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access token missing." });

  try {
    const userPayload = await verifyAsync(
      token,
      process.env.ACCESS_TOKEN_SECRET
    );
    req.user = userPayload;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired access token." });
  }
};

const refreshTokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  message: { error: "Too many refresh token requests. Try again later." },
});

// Apply limiter specifically on auth routes
const router = express.Router();

// POST /refresh-token: verify existing refresh token, rotate tokens
router.post("/refresh-token", refreshTokenLimiter, async (req, res) => {
  try {
    console.log("REFRESH TOKEN HIT");
    const token = req.cookies?.refreshToken;
    if (!token)
      return res.status(401).json({ error: "Refresh token missing." });

    const storedToken = await RefreshToken.findOne({ token, revoked: false });
    if (!storedToken)
      return res.status(403).json({ error: "Invalid refresh token." });

    const user = await verifyAsync(token, process.env.REFRESH_TOKEN_SECRET);

    // Revoke all current tokens for this user in one operation (including current token)
    await RefreshToken.updateMany(
      { userId: user.id, revoked: false },
      { revoked: true }
    );

    // Create tokens
    const newTokenPayload = { id: user.id, phone: user.phone };
    const accessToken = jwt.sign(
      newTokenPayload,
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: "1m" }
    );
    const newRefreshToken = jwt.sign(
      newTokenPayload,
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: "7d" }
    );

    await RefreshToken.create({
      userId: user.id,
      token: newRefreshToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ accessToken });
  } catch (error) {
    console.error("Refresh token error:", error);
    res.status(500).json({ error: "Server error during token refresh." });
  }
});

// GET /me: get current logged-in user profile
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("-passwordHash -__v"); // Exclude sensitive fields
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }
    res.json({ user }); // Send user data as JSON
  } catch (error) {
    console.error("Error fetching user profile:", error);
    res.status(500).json({ error: "Server error." });
  }
});

router.post("/register", authLimiter, async (req, res) => {
  try {
    const { name, email, phone, password, tower, flat } = req.body;

    if (!name || !email || !phone || !password || !tower || !flat) {
      return res.status(400).json({ error: "All fields are required." });
    }
    // Email validation regex (basic)
    const emailRegex = /\S+@\S+\.\S+/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }
    if (password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters." });
    }

    const existingUserByPhone = await User.findOne({ phone });
    if (existingUserByPhone) {
      return res
        .status(409)
        .json({ error: "User with this phone already exists." });
    }

    const existingUserByEmail = await User.findOne({ email });
    if (existingUserByEmail) {
      return res
        .status(409)
        .json({ error: "User with this email already exists." });
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const user = new User({ name, email, phone, passwordHash, tower, flat });
    await user.save();

    res.status(201).json({ message: "User registered successfully." });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Server error." });
  }
});

router.post("/login", authLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password)
      return res
        .status(400)
        .json({ error: "Phone and password are required." });

    const user = await User.findOne({ phone });
    if (!user)
      return res.status(401).json({ error: "Invalid phone or password." });

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid)
      return res.status(401).json({ error: "Invalid phone or password." });

    const tokenPayload = { id: user._id, phone: user.phone };

    const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
    const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;

    if (!ACCESS_TOKEN_SECRET || !REFRESH_TOKEN_SECRET) {
      throw new Error("JWT secret keys are not set in environment variables.");
    }

    const accessToken = jwt.sign(tokenPayload, ACCESS_TOKEN_SECRET, {
      expiresIn: "15m",
    });
    const refreshToken = jwt.sign(tokenPayload, REFRESH_TOKEN_SECRET, {
      expiresIn: "7d",
    });

    // Save refresh token to DB
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 7);
    await RefreshToken.create({
      userId: user._id,
      token: refreshToken,
      expiresAt: expiryDate,
    });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: "Login successful.",
      accessToken,
      user: { phone: user.phone, tower: user.tower, flat: user.flat },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Server error." });
  }
});

// Optional: logout route to clear refresh token (revoke in DB)
router.post("/logout", authLimiter, async (req, res) => {
  try {
    console.log("LOGOUT HIT");
    const token = req.cookies?.refreshToken;
    if (token) {
      await RefreshToken.findOneAndUpdate({ token }, { revoked: true });
    }
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
    });
    res.json({ message: "Logged out successfully." });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ error: "Server error during logout." });
  }
});

export default router;
export { authLimiter, authenticateToken };
