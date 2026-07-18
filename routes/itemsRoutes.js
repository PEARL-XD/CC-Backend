import express from "express";
import rateLimit from "express-rate-limit";
import Item from "../models/Item.js";
import StorefrontSettings from "../models/StorefrontSettings.js";
import { findItemByIdFlexible } from "../utils/itemLookup.js";
import {
  getDefaultDisplayPriceForItem,
  getDefaultSelectedSizeForItem,
  getPackOptions,
  normalizePricingMode,
} from "../utils/packPricing.js";

const router = express.Router();

const ITEMS_REQUEST_LIMIT = 60;
const SEARCH_LIMIT = 20;
const SEARCH_MIN_LENGTH = 2;
const SEARCH_MAX_LENGTH = 80;
const CACHE_TTL_MS = 60 * 1000;

const PUBLIC_PLACEHOLDER = "/images/placeholder.png";
const UPLOADED_SCREENSHOT = "/mnt/data/c53e2ca1-42d6-45e6-9cda-47676f31311e.png";
const DEFAULT_RTC_SECTION_IMAGE =
  "https://storage.googleapis.com/cccooked/banners/ready%20to%20cook.png";
const DEFAULT_DESSERT_SECTION_IMAGE =
  "https://storage.googleapis.com/cccooked/banners/desert.png";

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
export function clearItemsCache() {
  clearCache("items:");
  clearCache("search:");
  cache.clear();
}
function safeRegex(q) {
  return q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chooseImageUrl(itemImg) {
  if (itemImg && typeof itemImg === "string") return itemImg;
  return PUBLIC_PLACEHOLDER || UPLOADED_SCREENSHOT;
}

function normalizedCategoryKey(category) {
  return String(category || "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "");
}

function firstArticleImage(articles) {
  if (!Array.isArray(articles)) return "";

  for (const article of articles) {
    if (!article || typeof article !== "object") continue;
    const img = chooseImageUrl(article.img ?? article.image ?? "");
    if (img && img !== PUBLIC_PLACEHOLDER) {
      return img;
    }
  }

  return "";
}

function sectionImageFor(category, articles, settings = {}) {
  const normalized = normalizedCategoryKey(category);

  if (normalized === "uncooked") {
    return firstArticleImage(articles);
  }

  if (normalized === "cooked") {
    return firstArticleImage(articles);
  }

  if (normalized.includes("readytocook") || normalized.includes("rtc")) {
    return (
      settings.rtcSectionImage?.trim() ||
      DEFAULT_RTC_SECTION_IMAGE ||
      firstArticleImage(articles) ||
      ""
    );
  }

  if (normalized.includes("dessert")) {
    return (
      settings.dessertSectionImage?.trim() ||
      DEFAULT_DESSERT_SECTION_IMAGE ||
      firstArticleImage(articles) ||
      ""
    );
  }

  return firstArticleImage(articles) || "";
}

function buildPricingPayload(item) {
  const pricingMode = normalizePricingMode(item);
  const defaultSelectedSize = getDefaultSelectedSizeForItem(item);
  const pricingOptions = getPackOptions(item?.category, item).map((option) => ({
    size: option.size,
    label: option.label,
    rangeLabel: option.range,
    price: option.price,
  }));

  return {
    pricingMode,
    defaultSelectedSize,
    showSizeSelector: pricingMode !== "single",
    pricingOptions,
    displayPrice: getDefaultDisplayPriceForItem(item),
  };
}

async function getStorefrontSettings() {
  const settings = await StorefrontSettings.findOne({ key: "storefront" }).lean();
  return {
    cookedEnabled: settings?.cookedEnabled ?? true,
    storeOpen: settings?.storeOpen ?? true,
    packagingFee: settings?.packagingFee ?? 0,
    platformFee: settings?.platformFee ?? 0,
    rtcSectionImage:
      settings?.rtcSectionImage?.trim() || DEFAULT_RTC_SECTION_IMAGE,
    dessertSectionImage:
      settings?.dessertSectionImage?.trim() || DEFAULT_DESSERT_SECTION_IMAGE,
    bannerEnabled: settings?.bannerEnabled ?? false,
    bannerTitle: settings?.bannerTitle ?? "",
    bannerMessage: settings?.bannerMessage ?? "",
    bannerTone: settings?.bannerTone ?? "info",
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
        "_id name desc longdesc imgUrl price oldprice pricingOptions cookedQuarterPrice cookedHalfPrice cookedFullPrice rtc200Price rtc400Price proteinPer100g carbsPer100g caloriesPer100g category isOutOfStock isExternalItem showSourceNotice sourceNoticeTitle sourceNoticeMessage sourceLabel sourceUrl 200price 400Price 200gPrice 400gPrice servingSize"
      )
      .lean();

    const categoryMap = new Map();

    for (const it of items) {
      const img = chooseImageUrl(it.imgUrl);
      const category = it.category || "Uncategorized";
      const sectionDisabled = isCookedCategory(category) && !settings.cookedEnabled;
      const pricing = buildPricingPayload(it);

      if (!categoryMap.has(category)) categoryMap.set(category, []);
      categoryMap.get(category).push({
        _id: it._id,
        name: it.name,
        desc: it.desc,
        longdesc: it.longdesc,
        img,
        price: it.price ?? pricing.displayPrice,
        oldprice: it.oldprice,
        cookedQuarterPrice: it.cookedQuarterPrice,
        cookedHalfPrice: it.cookedHalfPrice,
        cookedFullPrice: it.cookedFullPrice,
        rtc200Price: it.rtc200Price,
        rtc400Price: it.rtc400Price,
        pricingMode: pricing.pricingMode,
        defaultSelectedSize: pricing.defaultSelectedSize,
        showSizeSelector: pricing.showSizeSelector,
        pricingOptions: pricing.pricingOptions,
        proteinPer100g: it.proteinPer100g,
        carbsPer100g: it.carbsPer100g,
        caloriesPer100g: it.caloriesPer100g,
        isExternalItem: Boolean(it.isExternalItem),
        showSourceNotice: Boolean(it.showSourceNotice),
        sourceNoticeTitle: it.sourceNoticeTitle,
        sourceNoticeMessage: it.sourceNoticeMessage,
        sourceLabel: it.sourceLabel,
        sourceUrl: it.sourceUrl,
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
        image: sectionImageFor(category, articles, settings),
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

router.get("/storefront", async (req, res) => {
  try {
    const settings = await getStorefrontSettings();
    return res.json({ settings });
  } catch (err) {
    console.error("GET /api/storefront error:", err);
    return res.status(500).json({ error: "Failed to fetch storefront" });
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
        .select("_id name price imgUrl desc category isOutOfStock isExternalItem showSourceNotice sourceNoticeTitle sourceNoticeMessage sourceLabel sourceUrl rtc200Price rtc400Price 200price 400Price 200gPrice 400gPrice servingSize cookedQuarterPrice cookedHalfPrice cookedFullPrice oldprice pricingOptions")
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
        .select("_id name price imgUrl desc category isOutOfStock isExternalItem showSourceNotice sourceNoticeTitle sourceNoticeMessage sourceLabel sourceUrl rtc200Price rtc400Price 200price 400Price 200gPrice 400gPrice servingSize cookedQuarterPrice cookedHalfPrice cookedFullPrice oldprice pricingOptions")
        .lean();
    }

    const normalized = results.map((it) => {
      const sectionDisabled =
        isCookedCategory(it.category) && !settings.cookedEnabled;
      const pricing = buildPricingPayload(it);

      return {
        _id: it._id,
        name: it.name,
        price: it.price ?? pricing.displayPrice,
        img: chooseImageUrl(it.imgUrl),
        desc: it.desc || "",
        pricingMode: pricing.pricingMode,
        pricingOptions: pricing.pricingOptions,
        isExternalItem: Boolean(it.isExternalItem),
        showSourceNotice: Boolean(it.showSourceNotice),
        sourceNoticeTitle: it.sourceNoticeTitle,
        sourceNoticeMessage: it.sourceNoticeMessage,
        sourceLabel: it.sourceLabel,
        sourceUrl: it.sourceUrl,
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
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ error: "Invalid item id" });
    }

    const settings = await getStorefrontSettings();

    const item = await findItemByIdFlexible(id);

    if (!item) return res.status(404).json({ error: "Item not found" });

    const sectionDisabled =
      isCookedCategory(item.category) && !settings.cookedEnabled;
    const pricing = buildPricingPayload(item);

    return res.json({
      _id: item._id,
      name: item.name,
      desc: item.desc,
      longdesc: item.longdesc,
      img: chooseImageUrl(item.imgUrl),
      price: item.price ?? pricing.displayPrice,
      oldprice: item.oldprice,
      cookedQuarterPrice: item.cookedQuarterPrice,
      cookedHalfPrice: item.cookedHalfPrice,
      cookedFullPrice: item.cookedFullPrice,
      rtc200Price: item.rtc200Price,
      rtc400Price: item.rtc400Price,
      pricingMode: pricing.pricingMode,
      defaultSelectedSize: pricing.defaultSelectedSize,
      showSizeSelector: pricing.showSizeSelector,
      pricingOptions: pricing.pricingOptions,
      displayPrice: pricing.displayPrice,
      proteinPer100g: item.proteinPer100g,
      carbsPer100g: item.carbsPer100g,
      caloriesPer100g: item.caloriesPer100g,
      category: item.category,
      servingSize: item.servingSize,
      isExternalItem: Boolean(item.isExternalItem),
      showSourceNotice: Boolean(item.showSourceNotice),
      sourceNoticeTitle: item.sourceNoticeTitle,
      sourceNoticeMessage: item.sourceNoticeMessage,
      sourceLabel: item.sourceLabel,
      sourceUrl: item.sourceUrl,
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
  clearItemsCache();
  res.json({ ok: true });
});

export default router;
