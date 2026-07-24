import mongoose from "mongoose";

const notificationReceiptSchema = new mongoose.Schema(
  {
    notificationId: {
      type: String,
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    token: {
      type: String,
      required: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ["android", "ios"],
      required: true,
    },
    type: {
      type: String,
      enum: ["broadcast", "order", "promo"],
      default: "broadcast",
      index: true,
    },
    route: {
      type: String,
      default: "/home",
    },
    title: {
      type: String,
      default: "",
    },
    body: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["SENT", "RECEIVED", "OPENED"],
      default: "SENT",
      index: true,
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
    receivedAt: {
      type: Date,
    },
    openedAt: {
      type: Date,
    },
  },
  { timestamps: true },
);

notificationReceiptSchema.index({ notificationId: 1, token: 1 }, { unique: true });

export default mongoose.model("NotificationReceipt", notificationReceiptSchema);
