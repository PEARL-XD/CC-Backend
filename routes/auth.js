import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";
import { promisify } from "util";
import crypto from "crypto";
import { Resend } from "resend";

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

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Too many reset attempts. Please try again later." },
});

function generateResetCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function hashResetCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

async function sendPasswordResetEmail({ to, name, code }) {
  if (!resend) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to: [to],
    subject: "Your CleanChops password reset code",
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6;">
        <h2>Reset your password</h2>
        <p>Hi ${name || "there"},</p>
        <p>Use this code to reset your CleanChops password:</p>
        <div style="font-size: 28px; font-weight: bold; letter-spacing: 6px; margin: 16px 0;">
          ${code}
        </div>
        <p>This code expires in 15 minutes.</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(error.message || "Failed to send reset email.");
  }
}

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
router.post("/forgot-password", passwordResetLimiter, async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ error: "Email is required." });
    }

    const user = await User.findOne({ email });

    // Always return the same message so attackers can't discover accounts
    const genericMessage = {
      message: "If an account exists for that email, a reset code has been sent.",
    };

    if (!user) {
      return res.status(200).json(genericMessage);
    }

    const code = generateResetCode();

    user.passwordResetCodeHash = hashResetCode(code);
    user.passwordResetExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    user.passwordResetAttempts = 0;
    await user.save();

    await sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      code,
    });

    return res.status(200).json(genericMessage);
  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({ error: "Could not process password reset." });
  }
});

router.post("/reset-password", passwordResetLimiter, async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();
    const code = req.body.code?.trim();
    const newPassword = req.body.newPassword ?? "";

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        error: "Email, code and new password are required.",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        error: "Password must be at least 8 characters.",
      });
    }

    const user = await User.findOne({ email });

    if (
      !user ||
      !user.passwordResetCodeHash ||
      !user.passwordResetExpiresAt
    ) {
      return res.status(400).json({ error: "Invalid or expired reset code." });
    }

    if (user.passwordResetExpiresAt.getTime() < Date.now()) {
      user.passwordResetCodeHash = null;
      user.passwordResetExpiresAt = null;
      user.passwordResetAttempts = 0;
      await user.save();

      return res.status(400).json({ error: "Reset code has expired." });
    }

    const incomingCodeHash = hashResetCode(code);

    if (incomingCodeHash !== user.passwordResetCodeHash) {
      user.passwordResetAttempts = (user.passwordResetAttempts || 0) + 1;
      await user.save();

      return res.status(400).json({ error: "Invalid or expired reset code." });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordResetCodeHash = null;
    user.passwordResetExpiresAt = null;
    user.passwordResetAttempts = 0;
    await user.save();

    await RefreshToken.updateMany(
      { userId: user._id, revoked: false },
      { revoked: true }
    );

    return res.status(200).json({
      message: "Password reset successful. Please log in again.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ error: "Could not reset password." });
  }
});


export default router;
export { authLimiter, authenticateToken };
