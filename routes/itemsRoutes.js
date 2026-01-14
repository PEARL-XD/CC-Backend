// backend/routes/itemsRouter.js
import express from "express";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import Item from "../models/Item.js";

const router = express.Router();

// -----------------------
// Configuration
// -----------------------
const ITEMS_REQUEST_LIMIT = 60; // per minute per IP
const SEARCH_LIMIT = 20; // max results returned for search
const SEARCH_MIN_LENGTH = 2; // min query length to run search
const SEARCH_MAX_LENGTH = 80; // max length to protect from abuse
const CACHE_TTL_MS = 60 * 1000; // 60 seconds simple cache for list/search

// Fallback placeholder on server public folder (recommended)
const PUBLIC_PLACEHOLDER = "/images/placeholder.png";
// Uploaded screenshot path (available inside this environment); used as last-resort fallback
const UPLOADED_SCREENSHOT = "/mnt/data/c53e2ca1-42d6-45e6-9cda-47676f31311e.png";

// -----------------------
// Rate limiter
// -----------------------
const itemsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: ITEMS_REQUEST_LIMIT,
  message: { error: "Too many requests to items API. Please try again later." },
});
router.use(itemsLimiter);

// -----------------------
// Simple in-memory cache (TTL)
// Replace with Redis/memcached for multi-instance deployments
// -----------------------
const cache = new Map();
function setCache(key, value, ttl = CACHE_TTL_MS) {
  const expiresAt = Date.now() + ttl;
  cache.set(key, { value, expiresAt });
}
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}
function clearCache(prefix = "") {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// -----------------------
// Helpers
// -----------------------
function safeRegex(q) {
  return q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function chooseImageUrl(itemImg) {
  // Prefer explicit item image, then public placeholder, then uploaded screenshot (session-only)
  if (itemImg && typeof itemImg === "string") return itemImg;
  // Use public placeholder if file present in your deployed public folder
  return PUBLIC_PLACEHOLDER || UPLOADED_SCREENSHOT;
}

// -----------------------
// 1) GET /api/items
// - returns items grouped by category (cached)
// -----------------------
router.get("/items", async (req, res) => {
  try {
    const cacheKey = "items:all";
    const cached = getCache(cacheKey);
    if (cached) {
      res.set("X-Cache", "HIT");
      return res.json(cached);
    }

    // Find items and project only required fields
    const items = await Item.find()
      .select(
        "_id name desc longdesc imgUrl price oldprice proteinPer100g carbsPer100g caloriesPer100g category"
      )
      .lean();

    // Group by category
    const categoryMap = new Map();
    for (const it of items) {
      const img = chooseImageUrl(it.imgUrl);
      const category = it.category || "Uncategorized";
      if (!categoryMap.has(category)) categoryMap.set(category, []);
      categoryMap.get(category).push({
        _id: it._id,
        name: it.name,
        desc: it.desc,
        longdesc: it.longdesc,
        img,
        price: it.price,
        oldprice: it.oldprice,
        proteinPer100g: it.proteinPer100g,
        carbsPer100g: it.carbsPer100g,
        caloriesPer100g: it.caloriesPer100g,
      });
    }

    const sections = [];
    for (const [category, articles] of categoryMap.entries()) {
      sections.push({
        title: category,
        image: category === "Uncooked" ? "/images/raw.png" : "/images/cooked.png",
        articles,
      });
    }

    setCache(cacheKey, sections);
    res.set("X-Cache", "MISS");
    return res.json(sections);
  } catch (err) {
    console.error("GET /api/items error:", err);
    return res.status(500).json({ error: "Failed to fetch items" });
  }
});

// -----------------------
// 2) GET /api/items/search?q=...
// - Must be before /items/:id
// - Uses text search if index present, otherwise regex fallback
// - Sanitizes & limits input for safety
// - Caches results for a short TTL
// -----------------------
router.get("/items/search", async (req, res) => {
  try {
    const rawQ = String(req.query.q || "").trim();
    if (!rawQ || rawQ.length < SEARCH_MIN_LENGTH) {
      return res.json({ items: [] });
    }
    if (rawQ.length > SEARCH_MAX_LENGTH) {
      return res.status(400).json({ error: "Search query too long" });
    }

    const cacheKey = `search:${rawQ.toLowerCase()}`;
    const cached = getCache(cacheKey);
    if (cached) {
      res.set("X-Cache", "HIT");
      return res.json({ items: cached });
    }

    const q = rawQ;
    let results = [];

    // Try text search (requires text index on fields like name, desc)
    const useTextSearch = true;
    if (useTextSearch) {
      try {
        results = await Item.find(
          { $text: { $search: q } },
          { score: { $meta: "textScore" } }
        )
          .sort({ score: { $meta: "textScore" } })
          .limit(SEARCH_LIMIT)
          .select("_id name price imgUrl desc")
          .lean();
      } catch (err) {
        // If text search fails (no index or other), we fallback to regex
        results = [];
      }
    }

    // Fallback to safe regex search if no results from text or text search failed
    if (!results.length) {
      const escaped = safeRegex(q);
      const re = new RegExp(escaped, "i");
      results = await Item.find(
        { $or: [{ name: re }, { desc: re }] },
        null,
        { limit: SEARCH_LIMIT }
      )
        .select("_id name price imgUrl desc")
        .lean();
    }

    // Normalize shape and images
    const normalized = results.map((it) => ({
      _id: it._id,
      name: it.name,
      price: it.price,
      img: chooseImageUrl(it.imgUrl),
      desc: it.desc || "",
    }));

    setCache(cacheKey, normalized);
    res.set("X-Cache", "MISS");
    return res.json({ items: normalized });
  } catch (err) {
    console.error("GET /api/items/search error:", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

// -----------------------
// 3) GET /api/items/:id
// - Last route (after /search)
// - Validates ObjectId before query
// -----------------------
router.get("/items/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid item id" });
    }

    const item = await Item.findById(id)
      .select(
        "_id name desc longdesc imgUrl price oldprice proteinPer100g carbsPer100g caloriesPer100g category"
      )
      .lean();

    if (!item) return res.status(404).json({ error: "Item not found" });

    return res.json({
      _id: item._id,
      name: item.name,
      desc: item.desc,
      longdesc: item.longdesc,
      img: chooseImageUrl(item.imgUrl),
      price: item.price,
      oldprice: item.oldprice,
      proteinPer100g: item.proteinPer100g,
      carbsPer100g: item.carbsPer100g,
      caloriesPer100g: item.caloriesPer100g,
      category: item.category,
    });
  } catch (err) {
    console.error("GET /items/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// -----------------------
// Optional maintenance endpoints (protected in future)
// - Clear cache (useful for admin operations after updates)
// -----------------------
router.post("/items/clear-cache", (req, res) => {
  // Warning: this is open now. Secure it with admin auth for production.
  clearCache("items:");
  clearCache("search:");
  cache.clear();
  res.json({ ok: true });
});

export default router;
