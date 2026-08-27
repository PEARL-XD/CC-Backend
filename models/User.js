import mongoose from "mongoose";

const savedLocationSchema = new mongoose.Schema(
  {
    locationKey: { type: String, default: "" },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    addressLine: { type: String, default: "" },
    addressLabel: { type: String, default: "" },
    placeName: { type: String, default: "" },
    street: { type: String, default: "" },
    subLocality: { type: String, default: "" },
    locality: { type: String, default: "" },
    administrativeArea: { type: String, default: "" },
    postalCode: { type: String, default: "" },
    tower: { type: String, default: "" },
    floor: { type: String, default: "" },
    flat: { type: String, default: "" },
    serviceable: { type: Boolean, default: false },
    serviceabilityMethod: { type: String, default: "" },
    serviceabilityMessage: { type: String, default: "" },
    checkedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  },
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    // Social accounts may add their real phone later from Profile/checkout.
    // Sparse keeps phone uniqueness for users who have supplied one.
    phone: { type: String, unique: true, sparse: true, default: undefined },
    passwordHash: { type: String, required: true },
    tower: { type: String, default: "" },
    floor: { type: String, default: "" },
    flat: { type: String, default: "" },
    society: { type: String, default: "" },
    deliveryLocation: {
      locationKey: { type: String, default: "" },
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      addressLine: { type: String, default: "" },
      addressLabel: { type: String, default: "" },
      placeName: { type: String, default: "" },
      street: { type: String, default: "" },
      subLocality: { type: String, default: "" },
      locality: { type: String, default: "" },
      administrativeArea: { type: String, default: "" },
      postalCode: { type: String, default: "" },
      tower: { type: String, default: "" },
      floor: { type: String, default: "" },
      flat: { type: String, default: "" },
      serviceable: { type: Boolean, default: false },
      serviceabilityMethod: { type: String, default: "" },
      serviceabilityMessage: { type: String, default: "" },
      checkedAt: { type: Date, default: null },
    },
    savedLocations: {
      type: [savedLocationSchema],
      default: [],
    },
    passwordResetCodeHash: {
      type: String,
      default: null,
    },
    passwordResetExpiresAt: {
      type: Date,
      default: null,
    },
    passwordResetAttempts: {
      type: Number,
      default: 0,
    },
    avatarStyle: {
      type: String,
      enum: ["neutral", "male", "female"],
      default: "neutral",
    },
    priceNoticeSeenAt: {
      type: Date,
      default: null,
    },
    authProvider: {
      type: String,
      enum: ["phone", "google", "apple"],
      default: "phone",
    },
    providerUid: {
      type: String,
      default: "",
    },
    role: { type: String, enum: ["user", "admin"], default: "user" }, // ← add this
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("User", userSchema);
