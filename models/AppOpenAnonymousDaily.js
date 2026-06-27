import mongoose from "mongoose";

const appOpenAnonymousDailySchema = new mongoose.Schema(
  {
    dateKey: {
      type: String,
      required: true,
      unique: true,
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

export default mongoose.model(
  "AppOpenAnonymousDaily",
  appOpenAnonymousDailySchema,
);
