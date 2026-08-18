function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function isPointLike(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ("latitude" in value || "longitude" in value)
  );
}

function normalizePoint(point) {
  const latitude = Number(point?.latitude);
  const longitude = Number(point?.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return { latitude, longitude };
}

function normalizePolygon(points) {
  if (!Array.isArray(points)) return [];

  return points.map(normalizePoint).filter(Boolean);
}

function normalizePolygons(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  if (raw.every(isPointLike)) {
    const polygon = normalizePolygon(raw);
    return polygon.length >= 3 ? [polygon] : [];
  }

  return raw
    .map((entry) => normalizePolygon(Array.isArray(entry) ? entry : []))
    .filter((polygon) => polygon.length >= 3);
}

function pointInPolygon(point, polygon) {
  if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;

  const x = Number(point.longitude);
  const y = Number(point.latitude);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i]?.longitude);
    const yi = Number(polygon[i]?.latitude);
    const xj = Number(polygon[j]?.longitude);
    const yj = Number(polygon[j]?.latitude);

    if (
      !Number.isFinite(xi) ||
      !Number.isFinite(yi) ||
      !Number.isFinite(xj) ||
      !Number.isFinite(yj)
    ) {
      continue;
    }

    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

function haversineMeters(a, b) {
  const lat1 = Number(a?.latitude);
  const lng1 = Number(a?.longitude);
  const lat2 = Number(b?.latitude);
  const lng2 = Number(b?.longitude);

  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const lat1Rad = toRad(lat1);
  const lat2Rad = toRad(lat2);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const aVal =
    sinLat * sinLat +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
  return R * c;
}

export function evaluateServiceability(location = {}, settings = {}) {
  const point = {
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
  };

  const normalizedSociety = normalizeText(location.society);
  const normalizedLocality = normalizeText(location.locality);
  const normalizedSubLocality = normalizeText(location.subLocality);
  const normalizedAddress = normalizeText(location.addressLine);

  const polygons = normalizePolygons(settings.serviceAreaPolygons);
  const legacyPolygons = polygons.length
    ? polygons
    : normalizePolygons(settings.serviceAreaPolygon);

  if (legacyPolygons.length > 0) {
    const serviceable = legacyPolygons.some((polygon) =>
      pointInPolygon(point, polygon),
    );
    return {
      serviceable,
      method: "polygon",
      message: serviceable
        ? "Great news. Your location is within our delivery zone."
        : "Sorry, this location is outside our current delivery zone.",
    };
  }

  const centerLat = Number(settings.serviceAreaCenterLat);
  const centerLng = Number(settings.serviceAreaCenterLng);
  const radiusMeters = Number(settings.serviceAreaRadiusMeters);
  if (
    Number.isFinite(centerLat) &&
    Number.isFinite(centerLng) &&
    Number.isFinite(radiusMeters) &&
    radiusMeters > 0
  ) {
    const distance = haversineMeters(point, {
      latitude: centerLat,
      longitude: centerLng,
    });
    const serviceable = distance <= radiusMeters;
    return {
      serviceable,
      method: "radius",
      message: serviceable
        ? "Great news. Your location is within our delivery radius."
        : "Sorry, this location is outside our current delivery radius.",
    };
  }

  const allowedSocieties = Array.isArray(settings.serviceableSocieties)
    ? settings.serviceableSocieties.map(normalizeText).filter(Boolean)
    : [];
  const allowedLocalities = Array.isArray(settings.serviceableLocalities)
    ? settings.serviceableLocalities.map(normalizeText).filter(Boolean)
    : [];

  const serviceable =
    allowedSocieties.length === 0 && allowedLocalities.length === 0
      ? true
      : [normalizedSociety, normalizedLocality, normalizedSubLocality, normalizedAddress].some(
          (value) =>
            value &&
            (allowedSocieties.some((allowed) => value.includes(allowed)) ||
              allowedLocalities.some((allowed) => value.includes(allowed))),
        );

  return {
    serviceable,
    method: "list",
    message: serviceable
      ? "Great news. Your location is serviceable."
      : "Sorry, we do not currently deliver to this location.",
  };
}
