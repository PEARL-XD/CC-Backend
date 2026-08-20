import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";
import { promisify } from "util";
import crypto from "crypto";
import { Resend } from "resend";

import User from "../models/User.js";
import RefreshToken from "../models/RefreshToken.js";
import Cart from "../models/Cart.js";
import DeviceToken from "../models/DeviceToken.js";
import SupportTicket from "../models/SupportTicket.js";
import StorefrontSettings from "../models/StorefrontSettings.js";
import { evaluateServiceability } from "../utils/serviceability.js";
import { buildStorefrontSettingsPayload } from "../utils/storefrontSettingsCache.js";

const verifyAsync = promisify(jwt.verify);
const router = express.Router();

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL = "15d";
const REFRESH_TOKEN_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;

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

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Too many reset attempts. Please try again later." },
});

const refreshCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  path: "/",
  maxAge: REFRESH_TOKEN_MAX_AGE_MS,
};

const PRICE_NOTICE_LAUNCH_AT = new Date(
  process.env.PRICE_NOTICE_LAUNCH_AT || "2026-07-25T00:00:00+05:30",
);

const avatarStyles = new Set(["neutral", "male", "female"]);

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;
const GOOGLE_WEB_CLIENT_ID =
  process.env.GOOGLE_WEB_CLIENT_ID ||
  "790301039130-082hd6s2vnh4rgoes6grl5fskq2bv80c.apps.googleusercontent.com";

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
  return String(value ?? "").trim();
}

function normalizePhone(value) {
  const digits = normalizeText(value).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 12 && digits.startsWith("91")) {
    return digits.slice(2);
  }
  return digits;
}

function buildLoosePhoneRegex(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return null;

  const pattern = digits
    .split("")
    .map((digit) => digit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\D*");

  return new RegExp(`.*${pattern}`);
}

function normalizeAvatarStyle(value) {
  if (value === undefined) return undefined;
  const avatarStyle = normalizeText(value).toLowerCase();
  return avatarStyles.has(avatarStyle) ? avatarStyle : null;
}

function shouldShowPriceNotice(user) {
  const createdAt = user?.createdAt ? new Date(user.createdAt) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) return false;

  const seenAt = user?.priceNoticeSeenAt ? new Date(user.priceNoticeSeenAt) : null;
  if (seenAt && !Number.isNaN(seenAt.getTime())) return false;

  return createdAt >= PRICE_NOTICE_LAUNCH_AT;
}

function hasMeaningfulLocation(location = {}) {
  return [
    location.latitude,
    location.longitude,
    location.addressLine,
    location.addressLabel,
    location.placeName,
    location.street,
    location.subLocality,
    location.locality,
    location.administrativeArea,
    location.postalCode,
    location.tower,
    location.floor,
    location.flat,
  ].some((value) => {
    if (value === undefined || value === null) return false;
    return String(value).trim().length > 0;
  });
}

function hasGpsCoordinates(location = {}) {
  const latitude = location.latitude;
  const longitude = location.longitude;

  if (latitude === undefined || latitude === null || String(latitude).trim() === "") {
    return false;
  }

  if (longitude === undefined || longitude === null || String(longitude).trim() === "") {
    return false;
  }

  return (
    Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))
  );
}

function normalizeLocationRecord(location = {}) {
  if (!location || typeof location !== "object") return {};

  return {
    locationKey: buildLocationKey(location),
    latitude: normalizeOptionalNumber(location.latitude),
    longitude: normalizeOptionalNumber(location.longitude),
    addressLine: normalizeText(location.addressLine),
    addressLabel: normalizeText(location.addressLabel),
    placeName: normalizeText(location.placeName),
    street: normalizeText(location.street),
    subLocality: normalizeText(location.subLocality),
    locality: normalizeText(location.locality),
    administrativeArea: normalizeText(location.administrativeArea),
    postalCode: normalizeText(location.postalCode),
    tower: normalizeText(location.tower),
    floor: normalizeText(location.floor),
    flat: normalizeText(location.flat),
    serviceable: location.serviceable === true,
    serviceabilityMethod: normalizeText(location.serviceabilityMethod),
    serviceabilityMessage: normalizeText(location.serviceabilityMessage),
    checkedAt: location.checkedAt ? new Date(location.checkedAt) : null,
  };
}

function buildLocationKey(location = {}) {
  const explicitKey = normalizeText(location.locationKey);
  if (explicitKey) return explicitKey.toLowerCase();

  return [
    normalizeText(location.addressLabel).toLowerCase(),
    normalizeText(location.addressLine).toLowerCase(),
    normalizeText(location.tower).toLowerCase(),
    normalizeText(location.floor).toLowerCase(),
    normalizeText(location.flat).toLowerCase(),
    Number.isFinite(location.latitude) ? location.latitude.toFixed(6) : "",
    Number.isFinite(location.longitude) ? location.longitude.toFixed(6) : "",
  ].join("|");
}

function mergeSavedLocations(existingLocations = [], nextLocation = null) {
  const locations = [];
  const seen = new Set();

  for (const rawLocation of existingLocations) {
    const location = normalizeLocationRecord(rawLocation);
    if (!hasMeaningfulLocation(location)) continue;

    const key = buildLocationKey(location);
    if (seen.has(key)) continue;

    seen.add(key);
    locations.push(location);
  }

  if (nextLocation) {
    const location = normalizeLocationRecord(nextLocation);
    if (hasMeaningfulLocation(location)) {
      const key = buildLocationKey(location);
      const filtered = locations.filter((item) => buildLocationKey(item) !== key);
      filtered.unshift(location);
      return filtered;
    }
  }

  return locations;
}

function hasLegacyAddressFields(user = {}) {
  return [user.tower, user.floor, user.flat, user.society].some((value) => {
    if (value === undefined || value === null) return false;
    return String(value).trim().length > 0;
  });
}

function buildLegacyDeliveryLocation(user = {}) {
  if (!hasLegacyAddressFields(user)) {
    return null;
  }

  const society = normalizeText(user.society);
  const tower = normalizeText(user.tower);
  const floor = normalizeText(user.floor);
  const flat = normalizeText(user.flat);
  const legacyUserKey = String(user._id ?? user.id ?? user.phone ?? "");

  const addressLine = [society, tower, floor, flat].filter(Boolean).join(", ");
  const addressLabel = society || tower || flat || "Home";

  return normalizeLocationRecord({
    locationKey: `legacy:${legacyUserKey}`,
    addressLine,
    addressLabel,
    placeName: society,
    tower,
    floor,
    flat,
    serviceable: true,
    serviceabilityMethod: "legacy",
    serviceabilityMessage: "",
    checkedAt: user.updatedAt || user.createdAt || null,
  });
}

function buildSavedLocationRecord(location = {}, serviceability = null) {
  const normalizedLocation = normalizeLocationRecord(location);
  normalizedLocation.locationKey = buildLocationKey(normalizedLocation);
  return {
    ...normalizedLocation,
    serviceable: serviceability?.serviceable ?? location.serviceable ?? false,
    serviceabilityMethod: serviceability?.method ?? location.serviceabilityMethod ?? "",
    serviceabilityMessage:
      serviceability?.message ?? location.serviceabilityMessage ?? "",
    checkedAt: new Date(),
  };
}

function buildClientUser(user) {
  const plainUser = user?.toObject ? user.toObject() : { ...user };
  delete plainUser.passwordHash;
  delete plainUser.__v;

  const legacyDeliveryLocation = buildLegacyDeliveryLocation(plainUser);
  const explicitDeliveryLocation = hasMeaningfulLocation(plainUser.deliveryLocation)
    ? normalizeLocationRecord(plainUser.deliveryLocation)
    : null;
  const deliveryLocation =
    explicitDeliveryLocation && hasGpsCoordinates(explicitDeliveryLocation)
      ? explicitDeliveryLocation
      : legacyDeliveryLocation || explicitDeliveryLocation;

  const savedLocations = mergeSavedLocations(
    Array.isArray(plainUser.savedLocations) ? plainUser.savedLocations : [],
    deliveryLocation,
  );
  return {
    ...plainUser,
    deliveryLocation,
    savedLocations,
    showPriceNotice: shouldShowPriceNotice(plainUser),
  };
}

function normalizeOptionalText(value) {
  if (value === undefined) return undefined;
  return normalizeText(value);
}

function normalizeOptionalNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildDeliveryLocationFromBody(body = {}) {
  const latitude = normalizeOptionalNumber(body.latitude);
  const longitude = normalizeOptionalNumber(body.longitude);

  return {
    locationKey: normalizeOptionalText(body.locationKey),
    latitude,
    longitude,
    addressLine: normalizeOptionalText(body.addressLine),
    addressLabel: normalizeOptionalText(body.addressLabel),
    placeName: normalizeOptionalText(body.placeName),
    street: normalizeOptionalText(body.street),
    subLocality: normalizeOptionalText(body.subLocality),
    locality: normalizeOptionalText(body.locality),
    administrativeArea: normalizeOptionalText(body.administrativeArea),
    postalCode: normalizeOptionalText(body.postalCode),
    tower: normalizeOptionalText(body.tower),
    floor: normalizeOptionalText(body.floor),
    flat: normalizeOptionalText(body.flat),
  };
}

function hasDeliveryLocation(location = {}) {
  return (
    location.latitude !== undefined ||
    location.longitude !== undefined ||
    location.addressLine !== undefined ||
    location.addressLabel !== undefined ||
    location.placeName !== undefined ||
    location.street !== undefined ||
    location.subLocality !== undefined ||
    location.locality !== undefined ||
    location.administrativeArea !== undefined ||
    location.postalCode !== undefined ||
    location.tower !== undefined ||
    location.floor !== undefined ||
    location.flat !== undefined
  );
}

function deriveSocietyFromLocation(location = {}) {
  return (
    normalizeText(location.society) ||
    normalizeText(location.addressLabel) ||
    normalizeText(location.locality) ||
    normalizeText(location.subLocality) ||
    normalizeText(location.administrativeArea) ||
    normalizeText(location.placeName) ||
    normalizeText(location.addressLine) ||
    normalizeText(location.street) ||
    normalizeText(location.tower)
  );
}

async function resolveServiceability(location = {}) {
  const settings = await StorefrontSettings.findOne({
    key: "storefront",
  }).lean();

  return evaluateServiceability(
    location,
    buildStorefrontSettingsPayload(settings || {}),
  );
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

function buildSocialPlaceholderPhone(provider, providerUid) {
  const seed = `${provider}:${providerUid}`;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const digest = crypto
      .createHash("sha256")
      .update(`${seed}:${attempt}`)
      .digest("hex");

    let digits = Array.from(digest)
      .map((char) => (char.charCodeAt(0) % 10).toString())
      .join("")
      .slice(0, 10);

    if (digits.length < 10) {
      digits = digits.padEnd(10, "0");
    }

    if (digits.startsWith("0")) {
      digits = `9${digits.slice(1)}`;
    }

    return digits;
  }

  return `9${Math.floor(Math.random() * 1_000_000_000)
    .toString()
    .padStart(9, "0")}`;
}

async function issueAuthSession(res, user, statusCode = 200, message = "Login successful.") {
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

  return res.status(statusCode).json({
    message,
    accessToken,
    user: buildClientUser(user),
  });
}

function getRefreshTokenFromRequest(req) {
  return req.cookies?.refreshToken || req.body?.refreshToken;
}

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
  } catch (_) {
    return res.status(401).json({ error: "Invalid or expired access token." });
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

    await RefreshToken.findOneAndUpdate(
      { token, revoked: false },
      { revoked: true },
      { new: false }
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

    if (
      error.name === "TokenExpiredError" ||
      error.name === "JsonWebTokenError"
    ) {
      return res
        .status(403)
        .json({ error: "Invalid or expired refresh token." });
    }

    return res
      .status(500)
      .json({ error: "Server error during token refresh." });
  }
});

// GET /me
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(sanitizeUserQuery());

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({ user: buildClientUser(user) });
  } catch (error) {
    console.error("Error fetching user profile:", error);
    return res.status(500).json({ error: "Server error." });
  }
});

// POST /serviceability/check
router.post("/serviceability/check", async (req, res) => {
  try {
    const location = buildDeliveryLocationFromBody(req.body);
    if (!hasDeliveryLocation(location)) {
      return res.status(400).json({ error: "Location data is required." });
    }

    const serviceability = await resolveServiceability({
      ...location,
      society: normalizeText(req.body.society || ""),
    });

    return res.json({
      success: true,
      serviceability,
    });
  } catch (error) {
    console.error("Serviceability check error:", error);
    return res.status(500).json({ error: "Could not check serviceability." });
  }
});

// POST /register
router.post("/register", authLimiter, async (req, res) => {
  try {
    const name = normalizeText(req.body.name);
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    const password = req.body.password ?? "";
    const tower = normalizeText(req.body.tower);
    const floor = normalizeText(req.body.floor);
    const flat = normalizeText(req.body.flat);
    const deliveryLocation = buildDeliveryLocationFromBody(req.body);
    const requestedSociety = normalizeText(req.body.society);
    const society = requestedSociety || deriveSocietyFromLocation(deliveryLocation);

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: "All fields are required." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }

    if (!isValidPhone(phone)) {
      return res
        .status(400)
        .json({ error: "Phone must be a valid 10-digit number." });
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

    const serviceability = hasDeliveryLocation(deliveryLocation)
      ? await resolveServiceability({
          ...deliveryLocation,
          society,
        })
      : { serviceable: true, method: "none", message: "" };
    const savedLocationRecord = hasDeliveryLocation(deliveryLocation)
      ? buildSavedLocationRecord(
          {
            ...deliveryLocation,
            society,
          },
          serviceability,
        )
      : null;

    const user = new User({
      name,
      email,
      phone,
      passwordHash,
      society,
      tower,
      floor,
      flat,
      ...(hasDeliveryLocation(deliveryLocation)
        ? {
            deliveryLocation: {
              ...deliveryLocation,
              serviceable: serviceability.serviceable,
              serviceabilityMethod: serviceability.method,
              serviceabilityMessage: serviceability.message,
              checkedAt: new Date(),
            },
            savedLocations: savedLocationRecord ? [savedLocationRecord] : [],
          }
        : {}),
    });

    await user.save();

    return res.status(201).json({
      message: "User registered successfully.",
      user: buildClientUser(user),
      serviceability,
    });
  } catch (error) {
    console.error("Registration error:", error);
    return res.status(500).json({ error: "Server error." });
  }
});

// POST /login
router.post("/login", authLimiter, async (req, res) => {
  try {
    const phoneInput = normalizeText(req.body.phone);
    const phone = normalizePhone(phoneInput);
    const password = req.body.password ?? "";

    console.log("Login request received", {
      phoneInput,
      phoneNormalized: phone,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });

    if (!phone || !password) {
      console.log("Login rejected: missing phone or password", {
        phoneInput,
        phoneNormalized: phone,
      });
      return res
        .status(400)
        .json({ error: "Phone and password are required." });
    }

    const phoneRegex = buildLoosePhoneRegex(phoneInput);
    const user = await User.findOne({
      $or: [
        { phone },
        ...(phoneInput ? [{ phone: phoneInput }] : []),
        ...(phoneRegex ? [{ phone: phoneRegex }] : []),
      ],
    });
    if (!user) {
      console.log("Login failed: user not found", {
        phoneInput,
        phoneNormalized: phone,
      });
      return res
        .status(404)
        .json({ error: "No account found for this phone number." });
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      console.log("Login failed: password mismatch", {
        userId: user._id.toString(),
        phoneInput,
        phoneNormalized: phone,
      });
      return res.status(401).json({ error: "Incorrect password." });
    }

    console.log("Login password matched", {
      userId: user._id.toString(),
      phoneNormalized: phone,
    });
    console.log("JWT tokens created", {
      userId: user._id.toString(),
      accessTokenTtl: ACCESS_TOKEN_TTL,
      refreshTokenTtl: REFRESH_TOKEN_TTL,
    });

    console.log("Login success", {
      userId: user._id.toString(),
      phoneNormalized: phone,
    });

    return issueAuthSession(res, user, 200, "Login successful.");
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Server error during login." });
  }
});

// POST /social-login
router.post("/social-login", authLimiter, async (req, res) => {
  try {
    const provider = normalizeText(req.body.provider).toLowerCase();
    const idToken = normalizeText(req.body.idToken);

    console.log("Social login request received", {
      provider,
      hasToken: Boolean(idToken),
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });

    if (provider !== "google") {
      return res.status(400).json({ error: "Unsupported social login provider." });
    }

    if (!idToken) {
      return res.status(400).json({ error: "Identity token is required." });
    }

    const tokenInfoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    );

    if (!tokenInfoRes.ok) {
      const text = await tokenInfoRes.text().catch(() => "");
      console.log("Google token verification failed", {
        status: tokenInfoRes.status,
        body: text,
      });
      return res.status(401).json({ error: "Invalid Google sign in token." });
    }

    const tokenInfo = await tokenInfoRes.json();
    const providerUid = normalizeText(tokenInfo.sub);
    const email = normalizeEmail(tokenInfo.email || req.body.email);
    const displayName = normalizeText(
      req.body.name ||
        tokenInfo.name ||
        tokenInfo.email?.split("@")?.[0] ||
        "CleanChops User",
    );

    if (!providerUid) {
      return res.status(400).json({ error: "Invalid social identity token." });
    }

    if (tokenInfo.aud && tokenInfo.aud !== GOOGLE_WEB_CLIENT_ID) {
      console.log("Google token audience mismatch", {
        aud: tokenInfo.aud,
        expected: GOOGLE_WEB_CLIENT_ID,
      });
      return res.status(401).json({ error: "Google token audience mismatch." });
    }

    if (!email) {
      return res
        .status(400)
        .json({ error: "Google account email is required for sign in." });
    }

    let user = await User.findOne({
      $or: [
        { providerUid },
        { email },
      ],
    });

    const updates = {
      name: displayName,
      email,
      providerUid,
      authProvider: provider,
    };

    if (user) {
      if (!normalizeText(user.providerUid)) {
        user.providerUid = providerUid;
      }
      user.authProvider = provider;
      user.name = displayName || user.name;
      user.email = email || user.email;
      if (!normalizeText(user.phone)) {
        user.phone = buildSocialPlaceholderPhone(provider, providerUid);
      }
      await user.save();
    } else {
      const phone = buildSocialPlaceholderPhone(provider, providerUid);
      user = new User({
        ...updates,
        phone,
        passwordHash: await bcrypt.hash(crypto.randomUUID(), 10),
      });
      await user.save();
    }

    console.log("Social login success", {
      provider,
      providerUid,
      userId: user._id.toString(),
      email,
    });

    return issueAuthSession(res, user, 200, "Login successful.");
  } catch (error) {
    console.error("Social login error:", error);
    return res.status(500).json({ error: "Server error during social login." });
  }
});

// POST /users/price-notice/ack
router.post("/users/price-notice/ack", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findByIdAndUpdate(
      userId,
      {
        priceNoticeSeenAt: new Date(),
      },
      {
        new: true,
      },
    ).select(sanitizeUserQuery());

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({
      success: true,
      user: buildClientUser(user),
    });
  } catch (error) {
    console.error("Price notice ack error:", error);
    return res.status(500).json({ error: "Could not save notice state." });
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

// DELETE /account
router.delete("/account", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId).select("_id");

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    await Promise.all([
      RefreshToken.updateMany({ userId }, { revoked: true }),
      DeviceToken.deleteMany({ user: userId }),
      Cart.deleteOne({ userId }),
      SupportTicket.deleteMany({ user: userId }),
    ]);

    await User.deleteOne({ _id: userId });

    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      path: "/",
    });

    return res.json({ message: "Account deleted successfully." });
  } catch (error) {
    console.error("Account deletion error:", error);
    return res.status(500).json({ error: "Could not delete account." });
  }
});

// PATCH /users/profile
router.patch("/users/profile", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const currentUser = await User.findById(userId).select("savedLocations");

    const name = normalizeText(req.body.name);
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    const society =
      req.body.society !== undefined ? normalizeText(req.body.society) : undefined;
    const tower =
      req.body.tower !== undefined ? normalizeText(req.body.tower) : undefined;
    const floor =
      req.body.floor !== undefined ? normalizeText(req.body.floor) : undefined;
    const flat =
      req.body.flat !== undefined ? normalizeText(req.body.flat) : undefined;
    const deliveryLocation =
      hasDeliveryLocation(req.body.location || {})
        ? buildDeliveryLocationFromBody(req.body.location)
        : hasDeliveryLocation(req.body)
          ? buildDeliveryLocationFromBody(req.body)
          : undefined;
    const avatarStyle = normalizeAvatarStyle(req.body.avatarStyle);

    if (!name || !email || !phone) {
      return res
        .status(400)
        .json({ error: "Name, email and phone are required." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }

    if (!isValidPhone(phone)) {
      return res
        .status(400)
        .json({ error: "Phone must be a valid 10-digit number." });
    }

    if (society !== undefined && !society) {
      return res.status(400).json({ error: "Society cannot be empty." });
    }

    if (tower !== undefined && !tower) {
      return res.status(400).json({ error: "Tower cannot be empty." });
    }

    if (floor !== undefined && !floor) {
      return res.status(400).json({ error: "Floor cannot be empty." });
    }

    if (flat !== undefined && !flat) {
      return res.status(400).json({ error: "Flat cannot be empty." });
    }

    if (avatarStyle === null) {
      return res.status(400).json({ error: "Invalid avatar style." });
    }

    if (deliveryLocation) {
      if (
        (deliveryLocation.latitude === null && req.body.location?.latitude !== undefined) ||
        (deliveryLocation.longitude === null && req.body.location?.longitude !== undefined)
      ) {
        return res.status(400).json({ error: "Invalid delivery location coordinates." });
      }
    }

    const serviceability = deliveryLocation
      ? await resolveServiceability({
          ...deliveryLocation,
          society: society ?? req.body.location?.society ?? "",
        })
      : null;

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
    if (society !== undefined) updates.society = society;
    if (tower !== undefined) updates.tower = tower;
    if (floor !== undefined) updates.floor = floor;
    if (flat !== undefined) updates.flat = flat;
    if (avatarStyle !== undefined) updates.avatarStyle = avatarStyle;
    if (deliveryLocation) {
      const savedLocationRecord = buildSavedLocationRecord(
        {
          ...deliveryLocation,
          society: society ?? req.body.location?.society ?? req.body.society ?? "",
        },
        serviceability,
      );

      updates.deliveryLocation = {
        ...deliveryLocation,
        serviceable: serviceability?.serviceable ?? false,
        serviceabilityMethod: serviceability?.method ?? "",
        serviceabilityMessage: serviceability?.message ?? "",
        checkedAt: new Date(),
      };
      updates.savedLocations = mergeSavedLocations(
        currentUser?.savedLocations || [],
        savedLocationRecord,
      );
    }

    const user = await User.findByIdAndUpdate(userId, updates, {
      new: true,
      runValidators: true,
    }).select(sanitizeUserQuery());

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({
      message: "Profile updated successfully.",
      user: buildClientUser(user),
    });
  } catch (error) {
    console.error("Profile update error:", error);
    return res
      .status(500)
      .json({ error: "Server error while updating profile." });
  }
});

// PATCH /users/location
router.patch("/users/location", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const currentUser = await User.findById(userId).select("savedLocations");
    const location = buildDeliveryLocationFromBody(req.body);
    const locationKey = buildLocationKey(location);

    if (!hasDeliveryLocation(location)) {
      return res.status(400).json({ error: "Location data is required." });
    }

    if (
      (location.latitude === null && req.body.latitude !== undefined) ||
      (location.longitude === null && req.body.longitude !== undefined)
    ) {
      return res.status(400).json({ error: "Invalid location coordinates." });
    }

    const serviceability = await resolveServiceability({
      ...location,
      society: deriveSocietyFromLocation({
        ...location,
        society: req.body.society,
      }),
    });

    const societyUpdate =
      req.body.society !== undefined
        ? normalizeText(req.body.society)
        : deriveSocietyFromLocation(location);

    const user = await User.findByIdAndUpdate(
      userId,
      {
        savedLocations: mergeSavedLocations(
          currentUser?.savedLocations || [],
          buildSavedLocationRecord(
            {
              ...location,
              locationKey,
              society: societyUpdate,
            },
            serviceability,
          ),
        ),
        deliveryLocation: {
          ...location,
          locationKey,
          serviceable: serviceability.serviceable,
          serviceabilityMethod: serviceability.method,
          serviceabilityMessage: serviceability.message,
          checkedAt: new Date(),
        },
        ...(req.body.tower !== undefined
          ? { tower: normalizeText(req.body.tower) }
          : {}),
        ...(req.body.floor !== undefined
          ? { floor: normalizeText(req.body.floor) }
          : {}),
        ...(req.body.flat !== undefined
          ? { flat: normalizeText(req.body.flat) }
          : {}),
        ...(societyUpdate ? { society: societyUpdate } : {}),
      },
      {
        new: true,
        runValidators: true,
      },
    ).select(sanitizeUserQuery());

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({
      success: true,
      user: buildClientUser(user),
      serviceability,
    });
  } catch (error) {
    console.error("Location save error:", error);
    return res.status(500).json({ error: "Could not save location." });
  }
});

// DELETE /users/location
router.delete("/users/location", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const targetLocationKey = normalizeText(req.body?.locationKey);

    if (!targetLocationKey) {
      return res.status(400).json({ error: "Location key is required." });
    }

    const currentUser = await User.findById(userId).select(
      "savedLocations deliveryLocation",
    );
    const savedLocations = Array.isArray(currentUser?.savedLocations)
      ? currentUser.savedLocations.map((item) => normalizeLocationRecord(item))
      : [];
    const remainingSavedLocations = savedLocations.filter(
      (item) => buildLocationKey(item) !== targetLocationKey.toLowerCase(),
    );

    const isCurrentDeliveryLocation =
      buildLocationKey(currentUser?.deliveryLocation || {}) ===
      targetLocationKey.toLowerCase();

    const nextDeliveryLocation = isCurrentDeliveryLocation
      ? remainingSavedLocations[0] || {}
      : currentUser?.deliveryLocation || {};

    const user = await User.findByIdAndUpdate(
      userId,
      {
        savedLocations: remainingSavedLocations,
        deliveryLocation: nextDeliveryLocation,
      },
      {
        new: true,
        runValidators: true,
      },
    ).select(sanitizeUserQuery());

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({
      success: true,
      user: buildClientUser(user),
    });
  } catch (error) {
    console.error("Location delete error:", error);
    return res.status(500).json({ error: "Could not delete location." });
  }
});

// POST /forgot-password
router.post("/forgot-password", passwordResetLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({ error: "Email is required." });
    }

    const user = await User.findOne({ email });

    const genericMessage = {
      message:
        "If an account exists for that email, a reset code has been sent.",
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

// POST /reset-password
router.post("/reset-password", passwordResetLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = normalizeText(req.body.code);
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

    if (!user || !user.passwordResetCodeHash || !user.passwordResetExpiresAt) {
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
      { revoked: true },
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
