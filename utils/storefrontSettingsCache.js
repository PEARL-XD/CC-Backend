import StorefrontSettings from "../models/StorefrontSettings.js";

const DEFAULT_RTC_SECTION_IMAGE =
  "https://storage.googleapis.com/cccooked/banners/ready%20to%20cook.png";
const DEFAULT_DESSERT_SECTION_IMAGE =
  "https://storage.googleapis.com/cccooked/banners/desert.png";
const DEFAULT_SERVICEABLE_SOCIETIES = [
  "Bharat City",
  "Delhi-99",
  "Oxy Homez",
  "K10 Koyal Enclave",
  "Planet One",
];
const DEFAULT_SERVICEABLE_LOCALITIES = [
  "Indraprastha, Ghaziabad",
  "Gagan Vihar, Sahibabad, Ghaziabad",
];

const CACHE_TTL_MS = 30 * 1000;
let cache = null;

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

function buildSettings(settings = {}) {
  const serviceAreaPolygons = normalizePolygons(settings?.serviceAreaPolygons);
  const legacyServiceAreaPolygon = serviceAreaPolygons.length
    ? serviceAreaPolygons[0]
    : normalizePolygons(settings?.serviceAreaPolygon)[0] || [];

  return {
    cookedEnabled: settings?.cookedEnabled ?? true,
    readyToEatEnabled: settings?.readyToEatEnabled ?? true,
    storeOpen: settings?.storeOpen ?? true,
    twoTimeModeEnabled: settings?.twoTimeModeEnabled ?? false,
    packagingFee: settings?.packagingFee ?? 0,
    platformFee: settings?.platformFee ?? 0,
    rtcSectionImage:
      settings?.rtcSectionImage?.trim() || DEFAULT_RTC_SECTION_IMAGE,
    dessertSectionImage:
      settings?.dessertSectionImage?.trim() || DEFAULT_DESSERT_SECTION_IMAGE,
    serviceableSocieties: Array.isArray(settings?.serviceableSocieties)
      ? settings.serviceableSocieties
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      : DEFAULT_SERVICEABLE_SOCIETIES,
    serviceableLocalities: Array.isArray(settings?.serviceableLocalities)
      ? settings.serviceableLocalities
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      : DEFAULT_SERVICEABLE_LOCALITIES,
    serviceAreaPolygon: legacyServiceAreaPolygon,
    serviceAreaPolygons,
    serviceAreaCenterLat:
      Number.isFinite(Number(settings?.serviceAreaCenterLat))
        ? Number(settings.serviceAreaCenterLat)
        : null,
    serviceAreaCenterLng:
      Number.isFinite(Number(settings?.serviceAreaCenterLng))
        ? Number(settings.serviceAreaCenterLng)
        : null,
    serviceAreaRadiusMeters:
      Number.isFinite(Number(settings?.serviceAreaRadiusMeters))
        ? Number(settings.serviceAreaRadiusMeters)
        : null,
    bannerEnabled: settings?.bannerEnabled ?? false,
    bannerTitle: settings?.bannerTitle ?? "",
    bannerMessage: settings?.bannerMessage ?? "",
    bannerTone: settings?.bannerTone ?? "info",
  };
}

export function clearStorefrontSettingsCache() {
  cache = null;
}

export async function getStorefrontSettings() {
  if (cache && Date.now() < cache.expiresAt) {
    return cache.value;
  }

  const settings = await StorefrontSettings.findOne({ key: "storefront" }).lean();
  const value = buildSettings(settings);

  cache = {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };

  return value;
}

export function buildStorefrontSettingsPayload(settings) {
  return buildSettings(settings);
}
