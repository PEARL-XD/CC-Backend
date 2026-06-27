import mongoose from "mongoose";

const appOpenDailySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    dateKey: {
      type: String,
      required: true,
      index: true,
    },
    openCount: {
      type: Number,
      default: 0,
    },
    firstOpenedAt: {
      type: Date,
      default: Date.now,
    },
    lastOpenedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

appOpenDailySchema.index({ user: 1, dateKey: 1 }, { unique: true });

export default mongoose.model("AppOpenDaily", appOpenDailySchema);
