import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    tower: { type: String, required: true },
    floor: { type: String, default: "" },
    flat: { type: String, required: true },
    society: { type: String, required: true },
    deliveryLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      addressLine: { type: String, default: "" },
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
    role: { type: String, enum: ["user", "admin"], default: "user" }, // ← add this
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("User", userSchema);
