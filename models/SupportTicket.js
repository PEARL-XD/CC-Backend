// models/SupportTicket.js
import mongoose from "mongoose";

const supportTicketSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    issueType: {
      type: String,
      enum: [
        "MISSING_ITEM",
        "WRONG_ITEM",
        "SHORT_WEIGHT",
        "NOT_FRESH",
        "POOR_PACKAGING",
        "LATE_DELIVERY",
        "POOR_QUALITY",
        "WRONG_CHARGE",
        "OTHER",
      ],
      required: true,
    },
    priority: {
      type: String,
      enum: ["Low", "Medium", "High"],
      default: "Medium",
    },
    description: {
      type: String,
      required: true,
      maxlength: 500,
    },
    status: {
      type: String,
      enum: ["OPEN", "IN_REVIEW", "RESOLVED", "CLOSED"],
      default: "OPEN",
    },
  },
  { timestamps: true }
);

export default mongoose.model("SupportTicket", supportTicketSchema);