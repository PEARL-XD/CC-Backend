import mongoose from "mongoose";

const storefrontSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    cookedEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const StorefrontSettings = mongoose.model(
  "StorefrontSettings",
  storefrontSettingsSchema
);

export default StorefrontSettings;
