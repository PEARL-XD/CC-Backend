import mongoose from "mongoose";

const DEFAULT_RTC_SECTION_IMAGE =
  "https://storage.googleapis.com/cccooked/banners/ready%20to%20cook.png";
const DEFAULT_DESSERT_SECTION_IMAGE =
  "https://storage.googleapis.com/cccooked/banners/desert.png";

const storefrontSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    cookedEnabled: { type: Boolean, default: true },
    storeOpen: { type: Boolean, default: true },
    packagingFee: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    rtcSectionImage: { type: String, default: DEFAULT_RTC_SECTION_IMAGE },
    dessertSectionImage: { type: String, default: DEFAULT_DESSERT_SECTION_IMAGE },
    bannerEnabled: { type: Boolean, default: false },
    bannerTitle: { type: String, default: "" },
    bannerMessage: { type: String, default: "" },
    bannerTone: { type: String, default: "info" },
  },
  { timestamps: true }
);

const StorefrontSettings = mongoose.model(
  "StorefrontSettings",
  storefrontSettingsSchema
);

export default StorefrontSettings;
