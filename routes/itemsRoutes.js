import express from "express";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import Item from "../models/Item.js";
import StorefrontSettings from "../models/StorefrontSettings.js";

const router = express.Router();

const ITEMS_REQUEST_LIMIT = 60;
const SEARCH_LIMIT = 20;
const SEARCH_MIN_LENGTH = 2;
const SEARCH_MAX_LENGTH = 80;
const CACHE_TTL_MS = 60 * 1000;

const PUBLIC_PLACEHOLDER = "/images/placeholder.png";
const UPLOADED_SCREENSHOT = "/mnt/data/c53e2ca1-42d6-45e6-9cda-47676f31311e.png";

const itemsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: ITEMS_REQUEST_LIMIT,
  message: { error: "Too many requests to items API. Please try again later." },
});
router.use(itemsLimiter);

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

function safeRegex(q) {
  return q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chooseImageUrl(itemImg) {
  if (itemImg && typeof itemImg === "string") return itemImg;
  return PUBLIC_PLACEHOLDER || UPLOADED_SCREENSHOT;
}

async function getStorefrontSettings() {
  const settings = await StorefrontSettings.findOne({ key: "storefront" }).lean();
  return {
    cookedEnabled: settings?.cookedEnabled ?? true,
  };
}

function isCookedCategory(category) {
  return String(category || "").trim().toLowerCase() === "cooked";
}

router.get("/items", async (req, res) => {
  try {
    const cacheKey = "items:all";
    const cached = getCache(cacheKey);
    if (cached) {
      res.set("X-Cache", "HIT");
      return res.json(cached);
    }

    const settings = await getStorefrontSettings();

    const items = await Item.find()
      .select(
        "_id name desc longdesc imgUrl price oldprice proteinPer100g carbsPer100g caloriesPer100g category isOutOfStock"
      )
      .lean();

    const categoryMap = new Map();

    for (const it of items) {
      const img = chooseImageUrl(it.imgUrl);
      const category = it.category || "Uncategorized";
      const sectionDisabled = isCookedCategory(category) && !settings.cookedEnabled;

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
        isOutOfStock: Boolean(it.isOutOfStock),
        isCategoryDisabled: sectionDisabled,
        isUnavailable: Boolean(it.isOutOfStock) || sectionDisabled,
      });
    }

    const sections = [];
    for (const [category, articles] of categoryMap.entries()) {
      const sectionDisabled = isCookedCategory(category) && !settings.cookedEnabled;

      sections.push({
        title: category,
        image: category === "Uncooked" ? "/images/raw.png" : "/images/cooked.png",
        isDisabled: sectionDisabled,
        disabledReason: sectionDisabled
          ? "Cooked section is not available right now."
          : "",
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

router.get("/items/search", async (req, res) => {
  try {
    const rawQ = String(req.query.q || "").trim();
    if (!rawQ || rawQ.length < SEARCH_MIN_LENGTH) {
      return res.json({ items: [] });
    }
    if (rawQ.length > SEARCH_MAX_LENGTH) {
      return res.status(400).json({ error: "Search query too long" });
    }

    const settings = await getStorefrontSettings();

    const cacheKey = `search:${rawQ.toLowerCase()}`;
    const cached = getCache(cacheKey);
    if (cached) {
      res.set("X-Cache", "HIT");
      return res.json({ items: cached });
    }

    const q = rawQ;
    let results = [];

    try {
      results = await Item.find(
        { $text: { $search: q } },
        { score: { $meta: "textScore" } }
      )
        .sort({ score: { $meta: "textScore" } })
        .limit(SEARCH_LIMIT)
        .select("_id name price imgUrl desc category isOutOfStock")
        .lean();
    } catch (_) {
      results = [];
    }

    if (!results.length) {
      const escaped = safeRegex(q);
      const re = new RegExp(escaped, "i");
      results = await Item.find(
        { $or: [{ name: re }, { desc: re }] },
        null,
        { limit: SEARCH_LIMIT }
      )
        .select("_id name price imgUrl desc category isOutOfStock")
        .lean();
    }

    const normalized = results.map((it) => {
      const sectionDisabled =
        isCookedCategory(it.category) && !settings.cookedEnabled;

      return {
        _id: it._id,
        name: it.name,
        price: it.price,
        img: chooseImageUrl(it.imgUrl),
        desc: it.desc || "",
        isOutOfStock: Boolean(it.isOutOfStock),
        isCategoryDisabled: sectionDisabled,
        isUnavailable: Boolean(it.isOutOfStock) || sectionDisabled,
      };
    });

    setCache(cacheKey, normalized);
    res.set("X-Cache", "MISS");
    return res.json({ items: normalized });
  } catch (err) {
    console.error("GET /api/items/search error:", err);
    return res.status(500).json({ error: "Search failed" });
  }
});

router.get("/items/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid item id" });
    }

    const settings = await getStorefrontSettings();

    const item = await Item.findById(id)
      .select(
        "_id name desc longdesc imgUrl price oldprice proteinPer100g carbsPer100g caloriesPer100g category isOutOfStock"
      )
      .lean();

    if (!item) return res.status(404).json({ error: "Item not found" });

    const sectionDisabled =
      isCookedCategory(item.category) && !settings.cookedEnabled;

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
      isOutOfStock: Boolean(item.isOutOfStock),
      isCategoryDisabled: sectionDisabled,
      isUnavailable: Boolean(item.isOutOfStock) || sectionDisabled,
    });
  } catch (err) {
    console.error("GET /items/:id error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/items/clear-cache", (req, res) => {
  clearCache("items:");
  clearCache("search:");
  cache.clear();
  res.json({ ok: true });
});

export default router;
