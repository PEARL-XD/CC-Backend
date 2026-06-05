import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { Resend } from "resend";
import SupportTicket from "../models/SupportTicket.js";
import { Order } from "../models/Order.js";
import { authenticateToken } from "./auth.js";

const router = express.Router();

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const PUBLIC_SUPPORT_TOPICS = new Set([
  "Order help",
  "Delivery issue",
  "Payment issue",
  "Product quality",
  "General question",
]);

// Max 5 support tickets per user per 10 minutes
const supportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req),
  message: { error: "Too many requests. Please wait before submitting again." },
});

const publicSupportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: ipKeyGenerator,
  message: { error: "Too many requests. Please wait before submitting again." },
});

const ISSUE_LABELS = {
  MISSING_ITEM: "Missing item",
  WRONG_ITEM: "Wrong cut / item",
  SHORT_WEIGHT: "Short weight",
  NOT_FRESH: "Not fresh / bad smell",
  POOR_PACKAGING: "Poor packaging",
  LATE_DELIVERY: "Late delivery",
  POOR_QUALITY: "Poor quality / taste",
  WRONG_CHARGE: "Wrong charge",
  OTHER: "Other",
};

const PRIORITY_EMOJI = {
  Low: "🟢",
  Medium: "🟡",
  High: "🔴",
};

function normalizeText(value) {
  return value?.trim() ?? "";
}

function isValidEmail(email) {
  return /\S+@\S+\.\S+/.test(email);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function sendPublicSupportEmail({
  name,
  email,
  orderId,
  topic,
  message,
}) {
  if (!resend) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const safeName = escapeHtml(name || "Anonymous");
  const safeEmail = escapeHtml(email);
  const safeOrderId = orderId ? escapeHtml(orderId) : "-";
  const safeTopic = escapeHtml(topic);
  const safeMessage = escapeHtml(message).replaceAll("\n", "<br />");

  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to: [process.env.SUPPORT_EMAIL_TO],
    replyTo: email,
    subject: `[Public Support] ${topic}${orderId ? ` - ${orderId}` : ""}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2 style="color:#E53935">Public support message</h2>
        <table cellpadding="6" style="font-size:14px;border-collapse:collapse;">
          <tr><td style="color:#6B7280;width:120px">Name</td><td>${safeName}</td></tr>
          <tr><td style="color:#6B7280">Email</td><td>${safeEmail}</td></tr>
          <tr><td style="color:#6B7280">Order ID</td><td>${safeOrderId}</td></tr>
          <tr><td style="color:#6B7280">Topic</td><td>${safeTopic}</td></tr>
        </table>
        <hr style="margin:16px 0;border:none;border-top:1px solid #E5E7EB" />
        <p style="color:#6B7280;font-size:13px;margin:0 0 8px;">Message</p>
        <div style="white-space:normal">${safeMessage}</div>
      </div>
    `,
  });

  if (error) {
    throw new Error(error.message || "Failed to send public support email.");
  }
}

async function sendSupportAlert(ticket, order, user) {
  if (!resend) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const itemList = order.items
    .map((i) => `• ${i.name} × ${i.quantity} (₹${i.price})`)
    .join("\n");

  const html = `
    <h2 style="color:#E53935">New Support Ticket #${ticket._id.toString().slice(-8)}</h2>
    <table cellpadding="6" style="font-family:sans-serif;font-size:14px;border-collapse:collapse;">
      <tr><td style="color:#6B7280;width:120px">Customer</td><td><strong>${user.name}</strong> (${user.phone})</td></tr>
      <tr><td style="color:#6B7280">Email</td><td>${user.email}</td></tr>
      <tr><td style="color:#6B7280">Society</td><td>${user.society ?? "-"}</td></tr>
      <tr><td style="color:#6B7280">Tower / Flat</td><td>${user.tower} / ${user.flat}</td></tr>
      <tr><td style="color:#6B7280">Order ID</td><td>#${order._id.toString().slice(-8)}</td></tr>
      <tr><td style="color:#6B7280">Order Total</td><td>₹${order.totalAmount}</td></tr>
      <tr><td style="color:#6B7280">Issue</td><td><strong>${ISSUE_LABELS[ticket.issueType]}</strong></td></tr>
      <tr><td style="color:#6B7280">Priority</td><td>${PRIORITY_EMOJI[ticket.priority]} ${ticket.priority}</td></tr>
      <tr><td style="color:#6B7280;vertical-align:top">Description</td><td>${ticket.description}</td></tr>
    </table>
    <hr style="margin:16px 0;border:none;border-top:1px solid #E5E7EB"/>
    <p style="color:#6B7280;font-size:13px">Items in order:</p>
    <pre style="font-size:13px">${itemList}</pre>
  `;

  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to: [process.env.SUPPORT_EMAIL_TO],
    subject: `[${ticket.priority}] New ticket — ${ISSUE_LABELS[ticket.issueType]} · Order #${order._id.toString().slice(-8)}`,
    html,
  });

  if (error) {
    throw new Error(error.message || "Failed to send support email.");
  }
}

async function sendResolutionEmail(ticket, issueLabel) {
  if (!resend) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to: [ticket.user.email],
    subject: "Your support ticket has been resolved",
    html: `
      <p>Hi ${ticket.user.name},</p>
      <p>Your support ticket for <strong>${issueLabel}</strong> (Order ₹${ticket.order?.totalAmount ?? ""}) has been <strong>resolved</strong>.</p>
      <p>If you're still facing the issue, you can raise a new ticket from the app.</p>
      <p>Thanks for your patience.</p>
    `,
  });

  if (error) {
    throw new Error(error.message || "Failed to send resolution email.");
  }
}

// POST /api/support
router.post("/support", authenticateToken, supportLimiter, async (req, res) => {
  try {
    const { orderId, issueType, priority, description } = req.body;

    if (!orderId || !issueType || !description?.trim()) {
      return res
        .status(400)
        .json({ error: "orderId, issueType, and description are required." });
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
      return res
        .status(400)
        .json({ error: "Description too long (max 500 chars)." });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    if (order.user.toString() !== req.user.id) {
      return res.status(403).json({ error: "Forbidden." });
    }

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

    const ticket = await SupportTicket.create({
      user: req.user.id,
      order: orderId,
      issueType,
      priority: priority || "Medium",
      description: description.trim(),
    });

    const User = (await import("../models/User.js")).default;
    const user = await User.findById(req.user.id)
      .select("name phone email society tower flat")
      .lean();

    sendSupportAlert(ticket, order, user).catch((err) =>
      console.error("Support email failed (ticket still saved):", err),
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

// POST /api/support/public
router.post("/support/public", publicSupportLimiter, async (req, res) => {
  try {
    const name = normalizeText(req.body.name);
    const email = normalizeText(req.body.email).toLowerCase();
    const orderId = normalizeText(req.body.orderId);
    const topic = normalizeText(req.body.topic) || "General question";
    const message = normalizeText(req.body.message);

    if (!email || !message) {
      return res
        .status(400)
        .json({ error: "Email and message are required." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }

    if (!PUBLIC_SUPPORT_TOPICS.has(topic)) {
      return res.status(400).json({ error: "Invalid topic." });
    }

    if (name && name.length > 100) {
      return res.status(400).json({ error: "Name is too long." });
    }

    if (orderId && orderId.length > 80) {
      return res.status(400).json({ error: "Order ID is too long." });
    }

    if (message.length > 2000) {
      return res.status(400).json({ error: "Message is too long." });
    }

    await sendPublicSupportEmail({
      name,
      email,
      orderId,
      topic,
      message,
    });

    return res.status(200).json({
      success: true,
      message: "Your support message has been sent.",
    });
  } catch (err) {
    console.error("Public support email error:", err);
    return res.status(500).json({ error: "Could not send your message." });
  }
});

// GET /api/support/me
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

// GET /api/admin/support
router.get("/admin/support", authenticateToken, async (req, res) => {
  try {
    const User = (await import("../models/User.js")).default;
    const adminUser = await User.findById(req.user.id).select("role").lean();

    if (adminUser?.role !== "admin") {
      return res.status(403).json({ error: "Admin access only." });
    }

    const { status, search, page = 1, limit = 20 } = req.query;

    const filter = {};
    if (status && status !== "ALL") filter.status = status;

    if (search?.trim()) {
      const regex = new RegExp(search.trim(), "i");
      const matchedUsers = await User.find({
        $or: [{ name: regex }, { phone: regex }, { email: regex }],
      })
        .select("_id")
        .lean();

      filter.user = { $in: matchedUsers.map((u) => u._id) };
    }

    const skip = (Number(page) - 1) * Number(limit);
    const total = await SupportTicket.countDocuments(filter);

    const tickets = await SupportTicket.find(filter)
      .populate("user", "name phone email tower flat")
      .populate("order", "totalAmount items createdAt orderStatus razorpayOrderId")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    const [openCount, inReviewCount, resolvedCount, totalCount] =
      await Promise.all([
        SupportTicket.countDocuments({ status: "OPEN" }),
        SupportTicket.countDocuments({ status: "IN_REVIEW" }),
        SupportTicket.countDocuments({ status: "RESOLVED" }),
        SupportTicket.countDocuments({}),
      ]);

    res.json({
      tickets,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
      summary: {
        open: openCount,
        inReview: inReviewCount,
        resolved: resolvedCount,
        total: totalCount,
      },
    });
  } catch (err) {
    console.error("Admin fetch support tickets error:", err);
    res.status(500).json({ error: "Failed to fetch tickets." });
  }
});

// PATCH /api/admin/support/:id/status
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

    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found." });
    }

    const prevStatus = ticket.status;
    ticket.status = status;
    await ticket.save();

    if (status === "RESOLVED" && prevStatus !== "RESOLVED") {
      const issueLabel = ISSUE_LABELS[ticket.issueType] || ticket.issueType;

      sendResolutionEmail(ticket, issueLabel).catch((err) =>
        console.error("Resolution email failed:", err),
      );
    }

    res.json({ success: true, ticket });
  } catch (err) {
    console.error("Update ticket status error:", err);
    res.status(500).json({ error: "Failed to update ticket." });
  }
});

export default router;
