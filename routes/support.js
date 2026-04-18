// routes/support.js
import express from "express";
import nodemailer from "nodemailer";
import rateLimit from "express-rate-limit";
import SupportTicket from "../models/SupportTicket.js";
import { Order } from "../models/Order.js";
import { authenticateToken } from "./auth.js";

const router = express.Router();

// Max 5 support tickets per user per 10 minutes — prevents spam
const supportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id ?? req.ip,
  message: { error: "Too many requests. Please wait before submitting again." },
});

// ── Nodemailer transporter ──────────────────────────────────────────
// Add these to your .env:
//   SUPPORT_EMAIL_USER=you@gmail.com
//   SUPPORT_EMAIL_PASS=your_gmail_app_password   ← use an App Password, not your real password
//   SUPPORT_EMAIL_TO=you@gmail.com               ← where alert emails land (can be same)
//
// Gmail App Password: https://myaccount.google.com/apppasswords
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SUPPORT_EMAIL_USER,
    pass: process.env.SUPPORT_EMAIL_PASS,
  },
});

const ISSUE_LABELS = {
  MISSING_ITEM:    "Missing item",
  WRONG_ITEM:      "Wrong cut / item",
  SHORT_WEIGHT:    "Short weight",
  NOT_FRESH:       "Not fresh / bad smell",
  POOR_PACKAGING:  "Poor packaging",
  LATE_DELIVERY:   "Late delivery",
  POOR_QUALITY:    "Poor quality / taste",
  WRONG_CHARGE:    "Wrong charge",
  OTHER:           "Other",
};

const PRIORITY_EMOJI = { Low: "🟢", Medium: "🟡", High: "🔴" };

async function sendSupportAlert(ticket, order, user) {
  const itemList = order.items
    .map((i) => `• ${i.name} × ${i.quantity} (₹${i.price})`)
    .join("\n");

  const html = `
    <h2 style="color:#4F46E5">New Support Ticket #${ticket._id.toString().slice(-8)}</h2>
    <table cellpadding="6" style="font-family:sans-serif;font-size:14px;border-collapse:collapse;">
      <tr><td style="color:#6B7280;width:120px">Customer</td><td><strong>${user.name}</strong> (${user.phone})</td></tr>
      <tr><td style="color:#6B7280">Email</td><td>${user.email}</td></tr>
      <tr><td style="color:#6B7280">Tower / Flat</td><td>${user.tower} / ${user.flat}</td></tr>
      <tr><td style="color:#6B7280">Order ID</td><td>#${order._id.toString().slice(-8)}</td></tr>
      <tr><td style="color:#6B7280">Order Total</td><td>₹${order.totalAmount}</td></tr>
      <tr><td style="color:#6B7280">Issue</td><td><strong>${ISSUE_LABELS[ticket.issueType]}</strong></td></tr>
      <tr><td style="color:#6B7280">Priority</td><td>${PRIORITY_EMOJI[ticket.priority]} ${ticket.priority}</td></tr>
      <tr><td style="color:#6B7280;vertical-align:top">Description</td><td>${ticket.description}</td></tr>
    </table>
    <hr style="margin:16px 0;border:none;border-top:1px solid #E5E7EB"/>
    <p style="color:#6B7280;font-size:13px">Items in order:<br><pre style="font-size:13px">${itemList}</pre></p>
  `;

  await transporter.sendMail({
    from: `"Support Alert" <${process.env.SUPPORT_EMAIL_USER}>`,
    to: process.env.SUPPORT_EMAIL_TO,
    subject: `[${ticket.priority}] New ticket — ${ISSUE_LABELS[ticket.issueType]} · Order #${order._id.toString().slice(-8)}`,
    html,
  });
}

// ── POST /api/support ───────────────────────────────────────────────
// Body: { orderId, issueType, priority, description }
// Auth: user
router.post("/support", authenticateToken, supportLimiter, async (req, res) => {
  try {
    const { orderId, issueType, priority, description } = req.body;

    // ── Validation ──
    if (!orderId || !issueType || !description?.trim()) {
      return res.status(400).json({ error: "orderId, issueType, and description are required." });
    }

    const allowedIssues = Object.keys(ISSUE_LABELS);
    if (!allowedIssues.includes(issueType)) {
      return res.status(400).json({ error: "Invalid issue type." });
    }

    const allowedPriorities = ["Low", "Medium", "High"];
    if (priority && !allowedPriorities.includes(priority)) {
      return res.status(400).json({ error: "Invalid priority." });
    }

    if (description.trim().length > 500) {
      return res.status(400).json({ error: "Description too long (max 500 chars)." });
    }

    // ── Ownership check: order must belong to this user ──
    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }
    if (order.user.toString() !== req.user.id) {
      return res.status(403).json({ error: "Forbidden." });
    }

    // ── Duplicate guard: one open ticket per order per issue type ──
    const existing = await SupportTicket.findOne({
      user: req.user.id,
      order: orderId,
      issueType,
      status: { $in: ["OPEN", "IN_REVIEW"] },
    }).lean();

    if (existing) {
      return res.status(409).json({
        error: "You already have an open ticket for this issue on this order.",
      });
    }

    // ── Create ticket ──
    const ticket = await SupportTicket.create({
      user: req.user.id,
      order: orderId,
      issueType,
      priority: priority || "Medium",
      description: description.trim(),
    });

    // ── Fire email alert (non-blocking — don't fail the request if email fails) ──
    const User = (await import("../models/User.js")).default;
    const user = await User.findById(req.user.id).select("name phone email tower flat").lean();

    sendSupportAlert(ticket, order, user).catch((err) =>
      console.error("Support email failed (ticket still saved):", err)
    );

    res.status(201).json({
      success: true,
      message: "Support ticket raised successfully.",
      ticketId: ticket._id,
    });
  } catch (err) {
    console.error("Support ticket error:", err);
    res.status(500).json({ error: "Failed to raise support ticket." });
  }
});

// ── GET /api/support/me — user's own tickets ────────────────────────
router.get("/support/me", authenticateToken, async (req, res) => {
  try {
    const tickets = await SupportTicket.find({ user: req.user.id })
      .populate("order", "totalAmount items createdAt")
      .sort({ createdAt: -1 });

    res.json({ tickets });
  } catch (err) {
    console.error("Fetch my tickets error:", err);
    res.status(500).json({ error: "Failed to fetch tickets." });
  }
});

// ── GET /api/admin/support — all tickets (admin) ────────────────────
router.get("/admin/support", authenticateToken, async (req, res) => {
  try {
    // Reuse the same role-based admin check pattern from your order routes
    const User = (await import("../models/User.js")).default;
    const user = await User.findById(req.user.id).select("role").lean();
    if (user?.role !== "admin") {
      return res.status(403).json({ error: "Admin access only." });
    }

    const tickets = await SupportTicket.find()
      .populate("user", "name phone email tower flat")
      .populate("order", "totalAmount items createdAt orderStatus")
      .sort({ createdAt: -1 });

    res.json({ tickets });
  } catch (err) {
    console.error("Admin fetch tickets error:", err);
    res.status(500).json({ error: "Failed to fetch tickets." });
  }
  // ── GET /api/admin/support ──────────────────────────────────────────
// Query params: status (optional), search (optional), page, limit
router.get("/admin/support", authenticateToken, async (req, res) => {
  try {
    const User = (await import("../models/User.js")).default;
    const user = await User.findById(req.user.id).select("role").lean();
    if (user?.role !== "admin") {
      return res.status(403).json({ error: "Admin access only." });
    }

    const { status, search, page = 1, limit = 20 } = req.query;

    // Build filter
    const filter = {};
    if (status && status !== "ALL") filter.status = status;

    // If search term given, find matching users first then filter by those user IDs
    if (search?.trim()) {
      const regex = new RegExp(search.trim(), "i");
      const matchedUsers = await User.find({
        $or: [{ name: regex }, { phone: regex }, { email: regex }],
      }).select("_id").lean();
      filter.user = { $in: matchedUsers.map((u) => u._id) };
    }

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await SupportTicket.countDocuments(filter);

    const tickets = await SupportTicket.find(filter)
      .populate("user", "name phone email tower flat")
      .populate("order", "totalAmount items createdAt orderStatus razorpayOrderId")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    // Summary counts — always over the full collection, not filtered
    const [openCount, reviewCount, resolvedCount, totalCount] = await Promise.all([
      SupportTicket.countDocuments({ status: "OPEN" }),
      SupportTicket.countDocuments({ status: "IN_REVIEW" }),
      SupportTicket.countDocuments({ status: "RESOLVED" }),
      SupportTicket.countDocuments({}),
    ]);

    res.json({
      tickets,
      pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) },
      summary: { open: openCount, inReview: reviewCount, resolved: resolvedCount, total: totalCount },
    });
  } catch (err) {
    console.error("Admin fetch support tickets error:", err);
    res.status(500).json({ error: "Failed to fetch tickets." });
  }
});

// ── PATCH /api/admin/support/:id/status ────────────────────────────
// Body: { status }
router.patch("/admin/support/:id/status", authenticateToken, async (req, res) => {
  try {
    const User = (await import("../models/User.js")).default;
    const user = await User.findById(req.user.id).select("role").lean();
    if (user?.role !== "admin") {
      return res.status(403).json({ error: "Admin access only." });
    }

    const { status } = req.body;
    const allowed = ["OPEN", "IN_REVIEW", "RESOLVED", "CLOSED"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }

    const ticket = await SupportTicket.findById(req.params.id)
      .populate("user", "name phone email")
      .populate("order", "totalAmount");

    if (!ticket) return res.status(404).json({ error: "Ticket not found." });

    const prevStatus = ticket.status;
    ticket.status = status;
    await ticket.save();

    // Optional: notify user by email when their ticket is resolved
    if (status === "RESOLVED" && prevStatus !== "RESOLVED") {
      const ISSUE_LABELS = {
        MISSING_ITEM: "Missing item", WRONG_ITEM: "Wrong cut / item",
        SHORT_WEIGHT: "Short weight", NOT_FRESH: "Not fresh / bad smell",
        POOR_PACKAGING: "Poor packaging", LATE_DELIVERY: "Late delivery",
        POOR_QUALITY: "Poor quality / taste", WRONG_CHARGE: "Wrong charge",
        OTHER: "Other",
      };
      const issueLabel = ISSUE_LABELS[ticket.issueType] || ticket.issueType;

      transporter.sendMail({
        from: `"Support" <${process.env.SUPPORT_EMAIL_USER}>`,
        to: ticket.user.email,
        subject: `Your support ticket has been resolved`,
        html: `
          <p>Hi ${ticket.user.name},</p>
          <p>Your support ticket for <strong>${issueLabel}</strong> (Order ₹${ticket.order?.totalAmount ?? ""}) has been <strong>resolved</strong>.</p>
          <p>If you're still facing the issue, you can raise a new ticket from the app.</p>
          <p>Thanks for your patience.</p>
        `,
      }).catch((err) => console.error("Resolution email failed:", err));
    }

    res.json({ success: true, ticket });
  } catch (err) {
    console.error("Update ticket status error:", err);
    res.status(500).json({ error: "Failed to update ticket." });
  }
});
});

export default router;