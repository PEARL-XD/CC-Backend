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
    role: { type: String, enum: ["user", "admin"], default: "user" }, // ← add this
  },
  {
    timestamps: true,
  },
);

export default mongoose.model("User", userSchema);
