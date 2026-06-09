import mongoose from "mongoose";

const storefrontSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    cookedEnabled: { type: Boolean, default: true },
    storeOpen: { type: Boolean, default: true },
    packagingFee: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const StorefrontSettings = mongoose.model(
  "StorefrontSettings",
  storefrontSettingsSchema
);

export default StorefrontSettings;
