const PACK_SIZES = [250, 500, 750, 1000];

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

const roundToTwo = (value) => Math.round((Number(value) || 0) * 100) / 100;

export function normalizePackSize(size) {
  const parsed = Number(size);
  return PACK_SIZES.includes(parsed) ? parsed : null;
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

export function getPackLabel(selectedSize) {
  const size = normalizePackSize(selectedSize);
  return size ? PACK_SIZE_META[size].label : `${Number(selectedSize) || 0} g Pack`;
}

export function getPackRange(selectedSize) {
  const size = normalizePackSize(selectedSize);
  return size ? PACK_SIZE_META[size].range : `${Number(selectedSize) || 0} g`;
}

export function getPackMeta(selectedSize, basePrice) {
  const size = normalizePackSize(selectedSize);
  const resolvedSize = size ?? Number(selectedSize ?? 0);

  return {
    size: resolvedSize,
    label: getPackLabel(resolvedSize),
    range: getPackRange(resolvedSize),
    price: calculatePackPrice(basePrice, resolvedSize),
  };
}

export { PACK_SIZES };
