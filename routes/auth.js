import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";
import { promisify } from "util";

import User from "../models/User.js";
import RefreshToken from "../models/RefreshToken.js";

const verifyAsync = promisify(jwt.verify);
const router = express.Router();

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL = "7d";
const REFRESH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const isProduction = process.env.NODE_ENV === "production";

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 25,
  message: { error: "Too many requests. Please try again later." },
});

const refreshTokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  message: { error: "Too many refresh token requests. Try again later." },
});

const refreshCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  path: "/",
  maxAge: REFRESH_TOKEN_MAX_AGE_MS,
};

function buildTokenPayload(user) {
  return {
    id: user.id || user._id.toString(),
    phone: user.phone,
  };
}

function signAccessToken(user) {
  return jwt.sign(buildTokenPayload(user), process.env.ACCESS_TOKEN_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

function signRefreshToken(user) {
  return jwt.sign(buildTokenPayload(user), process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: REFRESH_TOKEN_TTL,
  });
}

function normalizeEmail(email) {
  return email?.trim().toLowerCase() ?? "";
}

function normalizeText(value) {
  return value?.trim() ?? "";
}

function isValidEmail(email) {
  return /\S+@\S+\.\S+/.test(email);
}

function isValidPhone(phone) {
  return /^\d{10}$/.test(phone);
}

function sanitizeUserQuery() {
  return "-passwordHash -__v";
}

function getRefreshTokenFromRequest(req) {
  return req.cookies?.refreshToken || req.body?.refreshToken;
}

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access token missing." });
  }

  try {
    const payload = await verifyAsync(token, process.env.ACCESS_TOKEN_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired access token." });
  }
};

// POST /refresh-token
router.post("/refresh-token", refreshTokenLimiter, async (req, res) => {
  try {
    const token = getRefreshTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: "Refresh token missing." });
    }

    const storedToken = await RefreshToken.findOne({ token, revoked: false });
    if (!storedToken) {
      return res.status(403).json({ error: "Invalid refresh token." });
    }

    const decoded = await verifyAsync(token, process.env.REFRESH_TOKEN_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    await RefreshToken.updateMany(
      { userId: user._id, revoked: false },
      { revoked: true }
    );

    const accessToken = signAccessToken(user);
    const newRefreshToken = signRefreshToken(user);

    await RefreshToken.create({
      userId: user._id,
      token: newRefreshToken,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS),
    });

    res.cookie("refreshToken", newRefreshToken, refreshCookieOptions);
    return res.json({ accessToken });
  } catch (error) {
    console.error("Refresh token error:", error);

    if (error.name === "TokenExpiredError" || error.name === "JsonWebTokenError") {
      return res.status(403).json({ error: "Invalid or expired refresh token." });
    }

    return res.status(500).json({ error: "Server error during token refresh." });
  }
});

// GET /me
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(sanitizeUserQuery());

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({ user });
  } catch (error) {
    console.error("Error fetching user profile:", error);
    return res.status(500).json({ error: "Server error." });
  }
});

// POST /register
router.post("/register", authLimiter, async (req, res) => {
  try {
    const name = normalizeText(req.body.name);
    const email = normalizeEmail(req.body.email);
    const phone = normalizeText(req.body.phone);
    const password = req.body.password ?? "";
    const tower = normalizeText(req.body.tower);
    const flat = normalizeText(req.body.flat);

    if (!name || !email || !phone || !password || !tower || !flat) {
      return res.status(400).json({ error: "All fields are required." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: "Phone must be a valid 10-digit number." });
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

    const passwordHash = await bcrypt.hash(password, 10);

    const user = new User({
      name,
      email,
      phone,
      passwordHash,
      tower,
      flat,
    });

    await user.save();

    return res.status(201).json({
      message: "User registered successfully.",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        tower: user.tower,
        flat: user.flat,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    return res.status(500).json({ error: "Server error." });
  }
});

// POST /login
router.post("/login", authLimiter, async (req, res) => {
  try {
    const phone = normalizeText(req.body.phone);
    const password = req.body.password ?? "";

    if (!phone || !password) {
      return res.status(400).json({ error: "Phone and password are required." });
    }

    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(401).json({ error: "Invalid phone or password." });
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      return res.status(401).json({ error: "Invalid phone or password." });
    }

    if (!process.env.ACCESS_TOKEN_SECRET || !process.env.REFRESH_TOKEN_SECRET) {
      throw new Error("JWT secret keys are not set in environment variables.");
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    await RefreshToken.create({
      userId: user._id,
      token: refreshToken,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS),
    });

    res.cookie("refreshToken", refreshToken, refreshCookieOptions);

    return res.status(200).json({
      message: "Login successful.",
      accessToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        tower: user.tower,
        flat: user.flat,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Server error." });
  }
});

// POST /logout
router.post("/logout", authLimiter, async (req, res) => {
  try {
    const token = getRefreshTokenFromRequest(req);

    if (token) {
      await RefreshToken.findOneAndUpdate({ token }, { revoked: true });
    }

    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      path: "/",
    });

    return res.json({ message: "Logged out successfully." });
  } catch (error) {
    console.error("Logout error:", error);
    return res.status(500).json({ error: "Server error during logout." });
  }
});

// PATCH /users/profile
router.patch("/users/profile", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const name = normalizeText(req.body.name);
    const email = normalizeEmail(req.body.email);
    const phone = normalizeText(req.body.phone);
    const tower = req.body.tower !== undefined ? normalizeText(req.body.tower) : undefined;
    const flat = req.body.flat !== undefined ? normalizeText(req.body.flat) : undefined;

    if (!name || !email || !phone) {
      return res.status(400).json({ error: "Name, email and phone are required." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: "Phone must be a valid 10-digit number." });
    }

    if (tower !== undefined && !tower) {
      return res.status(400).json({ error: "Tower cannot be empty." });
    }

    if (flat !== undefined && !flat) {
      return res.status(400).json({ error: "Flat cannot be empty." });
    }

    const existingPhone = await User.findOne({
      phone,
      _id: { $ne: userId },
    });
    if (existingPhone) {
      return res.status(409).json({ error: "Phone already in use." });
    }

    const existingEmail = await User.findOne({
      email,
      _id: { $ne: userId },
    });
    if (existingEmail) {
      return res.status(409).json({ error: "Email already in use." });
    }

    const updates = { name, email, phone };
    if (tower !== undefined) updates.tower = tower;
    if (flat !== undefined) updates.flat = flat;

    const user = await User.findByIdAndUpdate(userId, updates, {
      new: true,
      runValidators: true,
    }).select(sanitizeUserQuery());

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({
      message: "Profile updated successfully.",
      user,
    });
  } catch (error) {
    console.error("Profile update error:", error);
    return res.status(500).json({ error: "Server error while updating profile." });
  }
});

export default router;
export { authLimiter, authenticateToken };
