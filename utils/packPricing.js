const UNCOOKED_PACK_SIZES = [250, 500, 750, 1000];
const COOKED_PACK_SIZES = [250, 500, 1000];
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

const roundToTwo = (value) => Math.round((Number(value) || 0) * 100) / 100;

export function normalizePackSize(size) {
  const parsed = Number(size);
  return [...UNCOOKED_PACK_SIZES, ...COOKED_PACK_SIZES].includes(parsed)
    ? parsed
    : null;
}

export function isCookedCategory(category) {
  return String(category || "").trim().toLowerCase() === "cooked";
}

export function getPackOptions(category) {
  return isCookedCategory(category)
    ? COOKED_PACK_SIZES.map((size) => ({
        size,
        ...COOKED_PACK_META[size],
      }))
    : UNCOOKED_PACK_SIZES.map((size) => ({
        size,
        ...PACK_SIZE_META[size],
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
  const cookedQuarterPrice = Number(item?.cookedQuarterPrice);
  const cookedHalfPrice = Number(item?.cookedHalfPrice);
  const cookedFullPrice = Number(item?.cookedFullPrice);

  if (!size) {
    return fallback;
  }

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

function getMetaByCategory(category, selectedSize) {
  const size = normalizePackSize(selectedSize);
  if (!size) {
    return {
      label: `${Number(selectedSize) || 0} Pack`,
      range: `${Number(selectedSize) || 0} g`,
    };
  }

  if (isCookedCategory(category)) {
    return COOKED_PACK_META[size] || {
      label: `${size} Pack`,
      range: `${size} g`,
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

  return {
    size: resolvedSize,
    label: getPackLabel(resolvedSize, category),
    range: getPackRange(resolvedSize, category),
    price: isCookedCategory(category)
      ? calculateCookedPackPrice({ price: basePrice }, resolvedSize)
      : calculatePackPrice(basePrice, resolvedSize),
  };
}

export function getPackPriceForItem(item, selectedSize) {
  return isCookedCategory(item?.category)
    ? calculateCookedPackPrice(item, selectedSize)
    : calculatePackPrice(item?.price, selectedSize);
}

export { UNCOOKED_PACK_SIZES as PACK_SIZES, COOKED_PACK_SIZES };
