const UNCOOKED_PACK_SIZES = [250, 500, 750, 1000];
const COOKED_PACK_SIZES = [250, 500, 1000];
const RTC_PACK_SIZES = [200, 400];

const PACK_SIZE_META = {
  250: {
    label: "Solo Pack",
    range: "230-270 g",
    surcharge: 10,
  },
  500: {
    label: "Duo Pack",
    range: "480-520 g",
    surcharge: 5,
  },
  750: {
    label: "Family Pack",
    range: "730-770 g",
    surcharge: 0,
  },
  1000: {
    label: "Party Pack",
    range: "980-1020 g",
    surcharge: 0,
  },
};

const COOKED_PACK_META = {
  250: {
    label: "Quarter",
    range: "Enough for 1-2",
  },
  500: {
    label: "Half",
    range: "Enough for 3-4",
  },
  1000: {
    label: "Full",
    range: "Enough for 6-8",
  },
};

const RTC_PACK_META = {
  200: {
    label: "200g",
    range: "Good for 1-2",
  },
  400: {
    label: "400g",
    range: "Good for 3-4",
  },
};

const roundToTwo = (value) => Math.round((Number(value) || 0) * 100) / 100;

function normalizeCategory(category) {
  return String(category || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function normalizeKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function hasNumericField(item, aliases) {
  if (!item || !aliases?.length) return false;

  const normalized = new Map(
    Object.entries(item).map(([key, value]) => [normalizeKey(key), value]),
  );

  return aliases.some((alias) => {
    const raw = normalized.get(normalizeKey(alias));
    return Number.isFinite(Number(raw));
  });
}

function readNumericField(item, aliases) {
  if (!item || !aliases?.length) return null;

  const normalized = new Map(
    Object.entries(item).map(([key, value]) => [normalizeKey(key), value]),
  );

  for (const alias of aliases) {
    const raw = normalized.get(normalizeKey(alias));
    const value = Number(raw);
    if (Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

export function normalizePackSize(size) {
  const parsed = Number(size);
  return [...UNCOOKED_PACK_SIZES, ...COOKED_PACK_SIZES, ...RTC_PACK_SIZES, 0].includes(parsed)
    ? parsed
    : null;
}

export function isCookedCategory(category) {
  return normalizeCategory(category) === "cooked";
}

export function isRtcCategory(category) {
  const normalized = normalizeCategory(category);
  return (
    normalized.includes("ready to cook") ||
    normalized.includes("rtc") ||
    normalized.includes("readytocook")
  );
}

export function isSingleCategory(category) {
  const normalized = normalizeCategory(category);
  return (
    normalized.includes("dessert") ||
    normalized.includes("drink") ||
    normalized.includes("beverage") ||
    normalized.includes("yogurt") ||
    normalized.includes("single")
  );
}

export function normalizePricingMode(item = {}) {
  const explicit = String(item?.pricingMode || "").trim().toLowerCase();
  if (explicit) return explicit;

  const category = item?.category;
  if (
    isCookedCategory(category) ||
    hasNumericField(item, [
      "cookedQuarterPrice",
      "cookedHalfPrice",
      "cookedFullPrice",
    ])
  ) {
    return "cooked";
  }

  if (
    isRtcCategory(category) ||
    hasNumericField(item, [
      "rtc200Price",
      "200price",
      "200Price",
      "200gPrice",
      "200GPrice",
      "price200",
      "price200g",
      "rtc400Price",
      "400price",
      "400Price",
      "400gPrice",
      "400GPrice",
      "price400",
      "price400g",
    ])
  ) {
    return "rtc";
  }

  if (isSingleCategory(category) || item?.servingSize != null) {
    return "single";
  }

  return "uncooked";
}

export function getAllowedSizesForItem(item = {}) {
  switch (normalizePricingMode(item)) {
    case "cooked":
      return COOKED_PACK_SIZES;
    case "rtc":
      return RTC_PACK_SIZES;
    case "single":
      return [0];
    case "uncooked":
    default:
      return UNCOOKED_PACK_SIZES;
  }
}

export function getPackOptions(category, item = null) {
  const mode = normalizePricingMode({ category, ...(item || {}) });

  if (mode === "single") {
    return [];
  }

  if (mode === "rtc") {
    return RTC_PACK_SIZES.map((size) => ({
      size,
      ...RTC_PACK_META[size],
      price: calculateRtcPackPrice(item || { category }, size),
    }));
  }

  if (mode === "cooked") {
    return COOKED_PACK_SIZES.map((size) => ({
      size,
      ...COOKED_PACK_META[size],
      price: calculateCookedPackPrice(item || { category }, size),
    }));
  }

  return UNCOOKED_PACK_SIZES.map((size) => ({
    size,
    ...PACK_SIZE_META[size],
    price: calculatePackPrice(item?.price, size),
  }));
}

export function calculatePackPrice(basePrice, selectedSize) {
  const size = normalizePackSize(selectedSize);
  const base = Number(basePrice) || 0;

  if (!size) {
    return roundToTwo(base);
  }

  const meta = PACK_SIZE_META[size] || { surcharge: 0 };
  const weightComponent = (base * size) / 1000;

  return roundToTwo(weightComponent + (meta.surcharge || 0));
}

export function calculateCookedPackPrice(item, selectedSize) {
  const size = normalizePackSize(selectedSize);
  const fallback = calculatePackPrice(item?.price, size);

  if (!size) {
    return fallback;
  }

  const cookedQuarterPrice = Number(item?.cookedQuarterPrice);
  const cookedHalfPrice = Number(item?.cookedHalfPrice);
  const cookedFullPrice = Number(item?.cookedFullPrice);

  switch (size) {
    case 250:
      return Number.isFinite(cookedQuarterPrice)
        ? roundToTwo(cookedQuarterPrice)
        : fallback;
    case 500:
      return Number.isFinite(cookedHalfPrice)
        ? roundToTwo(cookedHalfPrice)
        : fallback;
    case 1000:
      return Number.isFinite(cookedFullPrice)
        ? roundToTwo(cookedFullPrice)
        : fallback;
    default:
      return fallback;
  }
}

export function calculateRtcPackPrice(item, selectedSize) {
  const size = normalizePackSize(selectedSize);
  const fallback = roundToTwo(Number(item?.price) || 0);

  if (!size) {
    return fallback;
  }

  const aliasesBySize = {
    200: [
      "rtc200Price",
      "200price",
      "200Price",
      "200gPrice",
      "200GPrice",
      "price200",
      "price200g",
    ],
    400: [
      "rtc400Price",
      "400price",
      "400Price",
      "400gPrice",
      "400GPrice",
      "price400",
      "price400g",
    ],
  };

  const explicit = readNumericField(item, aliasesBySize[size] || []);
  if (Number.isFinite(explicit)) {
    return roundToTwo(explicit);
  }

  return fallback;
}

function getMetaByCategory(category, selectedSize) {
  const mode = normalizePricingMode({ category });
  const size = normalizePackSize(selectedSize);

  if (!size) {
    if (mode === "single") {
      return {
        label: "Single",
        range: "One serving",
      };
    }

    return {
      label: `${Number(selectedSize) || 0} Pack`,
      range: `${Number(selectedSize) || 0} g`,
    };
  }

  if (mode === "cooked") {
    return COOKED_PACK_META[size] || {
      label: `${size} Pack`,
      range: `${size} g`,
    };
  }

  if (mode === "rtc") {
    return RTC_PACK_META[size] || {
      label: `${size} g`,
      range: "Ready to cook",
    };
  }

  if (mode === "single") {
    return {
      label: "Single",
      range: "One serving",
    };
  }

  return PACK_SIZE_META[size] || {
    label: `${size} Pack`,
    range: `${size} g`,
  };
}

export function getPackLabel(selectedSize, category = "") {
  return getMetaByCategory(category, selectedSize).label;
}

export function getPackRange(selectedSize, category = "") {
  return getMetaByCategory(category, selectedSize).range;
}

export function getPackMeta(selectedSize, basePrice, category = "") {
  const size = normalizePackSize(selectedSize);
  const resolvedSize = size ?? Number(selectedSize ?? 0);
  const mode = normalizePricingMode({ category });

  return {
    size: resolvedSize,
    label: getPackLabel(resolvedSize, category),
    range: getPackRange(resolvedSize, category),
    price:
      mode === "cooked"
        ? calculateCookedPackPrice({ price: basePrice }, resolvedSize)
        : mode === "rtc"
          ? calculateRtcPackPrice({ price: basePrice }, resolvedSize)
          : mode === "single"
            ? roundToTwo(Number(basePrice) || 0)
            : calculatePackPrice(basePrice, resolvedSize),
  };
}

export function getDefaultSelectedSizeForItem(item = {}) {
  switch (normalizePricingMode(item)) {
    case "cooked":
      return 250;
    case "rtc":
      return 200;
    case "single":
      return 0;
    case "uncooked":
    default:
      return 250;
  }
}

export function getDefaultDisplayPriceForItem(item = {}) {
  const mode = normalizePricingMode(item);

  if (mode === "single") {
    return roundToTwo(Number(item?.price) || 0);
  }

  if (mode === "rtc") {
    return calculateRtcPackPrice(item, getDefaultSelectedSizeForItem(item));
  }

  if (mode === "cooked") {
    const cookedPrice =
      Number(item?.price) ||
      Number(item?.cookedFullPrice) ||
      Number(item?.cookedHalfPrice) ||
      Number(item?.cookedQuarterPrice) ||
      0;
    return roundToTwo(cookedPrice);
  }

  return roundToTwo(Number(item?.price) || 0);
}

export function getPackPriceForItem(item, selectedSize) {
  const mode = normalizePricingMode(item);

  if (mode === "single") {
    return roundToTwo(Number(item?.price) || 0);
  }

  if (mode === "rtc") {
    return calculateRtcPackPrice(item, selectedSize);
  }

  if (mode === "cooked") {
    return calculateCookedPackPrice(item, selectedSize);
  }

  return calculatePackPrice(item?.price, selectedSize);
}

export function packOldPriceForItem(item, selectedSize) {
  const oldPrice = item?.oldprice ?? item?.oldPrice;
  if (oldPrice == null) return null;

  const base = Number(oldPrice);
  if (!Number.isFinite(base) || base <= 0) return null;

  const mode = normalizePricingMode(item);

  if (mode === "single") {
    return roundToTwo(base);
  }

  return calculatePackPrice(base, selectedSize);
}

export function packDisplayText(selectedSize, { category = "", mode = "" } = {}) {
  const resolvedMode = mode || normalizePricingMode({ category });
  const label = getPackLabel(selectedSize, category);
  const range = getPackRange(selectedSize, category);

  if (resolvedMode === "single" || Number(selectedSize) <= 0) {
    return "Single";
  }

  if (!label || !range || label === range) {
    return label || range || `${selectedSize}`;
  }

  return `${label} • ${range}`;
}

export function weightRangeForSize(grams, { category } = {}) {
  return getPackRange(grams, category);
}

export {
  UNCOOKED_PACK_SIZES as PACK_SIZES,
  COOKED_PACK_SIZES,
  RTC_PACK_SIZES,
};
