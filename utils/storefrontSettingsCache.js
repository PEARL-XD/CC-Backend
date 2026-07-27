import StorefrontSettings from "../models/StorefrontSettings.js";

const DEFAULT_RTC_SECTION_IMAGE =
  "https://storage.googleapis.com/cccooked/banners/ready%20to%20cook.png";
const DEFAULT_DESSERT_SECTION_IMAGE =
  "https://storage.googleapis.com/cccooked/banners/desert.png";

const CACHE_TTL_MS = 30 * 1000;
let cache = null;

function buildSettings(settings = {}) {
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
