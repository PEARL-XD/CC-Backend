import express from "express";
import crypto from "crypto";
import { razorpay } from "../config/razorpay.js";
import { Order } from "../models/Order.js";
import Item from "../models/Item.js";
import { authenticateToken } from "./auth.js";
import StorefrontSettings from "../models/StorefrontSettings.js";
import { sendPushToAdmins, sendPushToUser } from "../utils/pushNotifications.js";
import { calculatePackPrice } from "../utils/packPricing.js";

const router = express.Router();

/* ---------------- HELPERS ---------------- */

/**
 * Role-based admin check.
 * Requires a `role` field on your User model (set server-side only).
 * To migrate: add `role: { type: String, enum: ["user","admin"], default: "user" }`
 * to your User schema, then set role:"admin" directly in MongoDB for your admin account.
 *
 * The old phone-based check is replaced because req.user comes from the JWT payload,
 * which a client controls the contents of at registration time.
 */
import User from "../models/User.js";
const isAdmin = async (req) => {
  const user = await User.findById(req.user.id).select("role").lean();
  return user?.role === "admin";
};

const ORDER_STATUS_MESSAGES = {
  PLACED: {
    title: "Order placed",
    body: "We have received your order.",
  },
  CONFIRMED: {
    title: "Order confirmed",
    body: "Your order has been confirmed.",
  },
  PACKED: {
    title: "Order packed",
    body: "Your order is packed and getting ready to leave.",
  },
  OUT_FOR_DELIVERY: {
    title: "Out for delivery",
    body: "Your order is on the way.",
  },
  DELIVERED: {
    title: "Order delivered",
    body: "Your order has been delivered.",
  },
  CANCELLED: {
    title: "Order cancelled",
    body: "Your order has been cancelled.",
  },
};

const formatOrderItemCount = (order) => {
  const count = Array.isArray(order.items)
    ? order.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
    : 0;
  return count;
};

const logOrderSummary = (label, order) => {
  console.log(label, {
    orderId: order._id?.toString?.() ?? String(order._id ?? ""),
    userId: order.user?.toString?.() ?? String(order.user ?? ""),
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    totalAmount: order.totalAmount,
    packagingFee: Number(order.packagingFee || 0),
    platformFee: Number(order.platformFee || 0),
    itemCount: formatOrderItemCount(order),
    silentDelivery: Boolean(order.silentDelivery),
  });
};

const sendOrderStatusNotification = async (order, status) => {
  const config = ORDER_STATUS_MESSAGES[status];
  if (!config) return;

  const body =
    status === "DELIVERED" && order.silentDelivery
      ? "Your order has been delivered and left at your door."
      : config.body;

  return sendPushToUser({
    userId: order.user.toString(),
    title: config.title,
    body,
    preferenceType: "order",
    data: {
      type: "order",
      route: "/orders",
      orderId: order._id.toString(),
      orderStatus: status,
    },
  });
};

const sendNewOrderAdminNotification = async (order) => {
  const itemCount = formatOrderItemCount(order);
  const amountValue = Number(order.totalAmount || 0);
  const amount = Number.isInteger(amountValue)
    ? String(amountValue)
    : amountValue.toFixed(2);

  return sendPushToAdmins({
    title: "New order received",
    body: `Rs. ${amount} order placed with ${itemCount} item${itemCount === 1 ? "" : "s"}.`,
    data: {
      type: "admin_order",
      route: "/admin",
      orderId: order._id.toString(),
      orderStatus: "PLACED",
      orderAmount: String(order.totalAmount ?? ""),
    },
  });
};

const confirmRazorpayOrder = async ({
  order,
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature,
}) => {
  if (order.paymentStatus === "PAID") {
    return { statusCode: 409, error: "Order already verified", order };
  }

  const body = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    await cancelOrderForPaymentIssue(order, "FAILED");
    return { statusCode: 400, error: "Invalid payment signature", order };
  }

  order.paymentStatus = "PAID";
  order.orderStatus = "CONFIRMED";

  const alreadyConfirmed = order.statusTimeline?.some(
    (entry) => entry.status === "CONFIRMED",
  );

  if (!alreadyConfirmed) {
    order.statusTimeline.push({ status: "CONFIRMED", time: new Date() });
  }

  await order.save();
  logOrderSummary("Payment verified:", order);

  try {
    const notificationResult = await sendOrderStatusNotification(
      order,
      "CONFIRMED",
    );
    console.log("Customer order notification result:", notificationResult);
  } catch (error) {
    console.error("Customer order notification failed:", error);
  }

  return { statusCode: 200, order };
};

const buildPaymentResultHtml = ({ localOrderId, status, message = "" }) => {
  const query = new URLSearchParams({
    status,
    localOrderId: String(localOrderId || ""),
  });

  if (message) {
    query.set("message", message);
  }

  const deepLink = `cleanchops://payment-result?${query.toString()}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Payment Result</title>
    <script>
      window.location.replace(${JSON.stringify(deepLink)});
    </script>
  </head>
  <body style="font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fff;color:#111;">
    <div>Completing payment...</div>
  </body>
</html>`;
};

const buildRazorpayWebviewCheckoutHtml = ({
  key,
  amount,
  currency,
  razorpayOrderId,
  localOrderId,
  callbackUrl,
  preferredMethod = "upi",
}) => {
  const dismissUrl = `cleanchops://payment-result?status=cancelled&localOrderId=${encodeURIComponent(
    localOrderId,
  )}`;

  const normalizedMethod = String(preferredMethod || "upi")
    .trim()
    .toLowerCase();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CleanChops Payment</title>
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(180deg, #fff8f3 0%, #ffffff 100%);
        color: #111827;
      }
      .card {
        text-align: center;
        padding: 24px;
        max-width: 320px;
      }
      .spinner {
        width: 28px;
        height: 28px;
        border: 3px solid rgba(229, 57, 53, 0.18);
        border-top-color: #e53935;
        border-radius: 999px;
        margin: 0 auto 14px;
        animation: spin 0.9s linear infinite;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      h1 {
        font-size: 18px;
        margin: 0 0 8px;
      }
      p {
        margin: 0;
        color: #6b7280;
        line-height: 1.5;
      }
    </style>
    <script>
      function buildOptions() {
        const method = (function () {
          switch (${JSON.stringify(normalizedMethod)}) {
            case "card":
              return {
                upi: false,
                card: true,
                netbanking: false,
                wallet: false,
              };
            case "netbanking":
              return {
                upi: false,
                card: false,
                netbanking: true,
                wallet: false,
              };
            case "more":
              return {
                upi: true,
                card: true,
                netbanking: true,
                wallet: true,
              };
            case "upi":
            default:
              return {
                upi: true,
                card: false,
                netbanking: false,
                wallet: false,
              };
          }
        })();

        return {
          key: ${JSON.stringify(key)},
          amount: ${JSON.stringify(amount)},
          currency: ${JSON.stringify(currency)},
          order_id: ${JSON.stringify(razorpayOrderId)},
          name: "CleanChops",
          description: "Order Payment",
          theme: { color: "#E53935" },
          method,
          webview_intent: true,
          redirect: true,
          callback_url: ${JSON.stringify(callbackUrl)},
          modal: {
            ondismiss: function () {
              window.location.href = ${JSON.stringify(dismissUrl)};
            },
          },
        };
      }

      function startCheckout() {
        const options = buildOptions();
        const rzp = new Razorpay(options);
        rzp.open();
      }

      window.addEventListener("load", startCheckout);
    </script>
  </head>
  <body>
    <div class="card">
      <div class="spinner"></div>
      <h1>Opening secure payment</h1>
      <p>Please wait while we launch Razorpay.</p>
    </div>
  </body>
</html>`;
};

const cancelOrderForPaymentIssue = async (order, paymentStatus) => {
  order.paymentStatus = paymentStatus;
  order.orderStatus = "CANCELLED";

  const alreadyCancelled = order.statusTimeline?.some(
    (entry) => entry.status === "CANCELLED",
  );

  if (!alreadyCancelled) {
    order.statusTimeline.push({ status: "CANCELLED", time: new Date() });
  }

  await order.save();
  await sendOrderStatusNotification(order, "CANCELLED");
};

/* ---------------- ROUTES ---------------- */

/**
 * POST /api/orders/create
 * Body: { cartItems: [{ _id, quantity, selectedSize }], schedule?: string, silentDelivery?: boolean }
 * Auth: user
 */
router.post("/orders/create", authenticateToken, async (req, res) => {
  try {
    const { cartItems, schedule } = req.body;

    const silentDelivery =
      req.body.silentDelivery === true || req.body.silentDelivery === "true";

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const productIds = cartItems.map((i) => i._id);
    const products = await Item.find({ _id: { $in: productIds } }).lean();

    const settings = await StorefrontSettings.findOne({
      key: "storefront",
    }).lean();

    const cookedEnabled = settings?.cookedEnabled ?? true;
    const storeOpen = settings?.storeOpen ?? true;
    const packagingFee = Number(settings?.packagingFee || 0);
    const platformFee = Number(settings?.platformFee || 0);
    const scheduleText = String(schedule || "").trim();

    if (!storeOpen && !scheduleText) {
      return res.status(400).json({
        error:
          "Store is closed right now. It reopens in the morning, but you can schedule your order for now.",
      });
    }

    const productMap = Object.fromEntries(
      products.map((p) => [p._id.toString(), p])
    );

    const verifiedItems = [];

    for (const item of cartItems) {
      const product = productMap[item._id?.toString()];

      if (!product) {
        return res.status(400).json({
          error: `Product not found: ${item._id}`,
        });
      }

      if (product.isOutOfStock === true) {
        return res.status(400).json({
          error: `${product.name} is currently out of stock`,
        });
      }

      const isCooked =
        String(product.category || "").trim().toLowerCase() === "cooked";

      if (isCooked && !cookedEnabled) {
        return res.status(400).json({
          error: "Cooked food is coming soon to your society.",
        });
      }

      const selectedSize = Number(item.selectedSize);
      const quantity = Number(item.quantity);

      if (![250, 500, 750, 1000].includes(selectedSize)) {
        return res.status(400).json({
          error: `Invalid size for ${product.name}`,
        });
      }

      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        return res.status(400).json({
          error: `Invalid quantity for ${product.name}`,
        });
      }

      const unitPrice = calculatePackPrice(product.price, selectedSize);

      verifiedItems.push({
        _id: product._id,
        name: product.name,
        img: product.imgUrl,
        price: unitPrice,
        selectedSize,
        quantity,
      });
    }

    const subtotalAmount = verifiedItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    const totalAmount = subtotalAmount + packagingFee + platformFee;

    if (subtotalAmount <= 0 || totalAmount <= 0) {
      return res.status(400).json({ error: "Invalid order amount" });
    }

    const amountInPaise = Math.round(totalAmount * 100);

    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
    });

    const order = await Order.create({
      user: req.user.id,
      items: verifiedItems,
      schedule: scheduleText || undefined,
      packagingFee,
      platformFee,
      totalAmount,
      razorpayOrderId: razorpayOrder.id,
      paymentStatus: "PENDING",
      orderStatus: "PLACED",
      silentDelivery,
      statusTimeline: [{ status: "PLACED", time: new Date() }],
    });

    logOrderSummary("Order created:", order);

    await sendNewOrderAdminNotification(order)
      .then((result) => {
        console.log("Admin order notification result:", result);
      })
      .catch((error) => {
        console.error("Admin order notification failed:", error);
      });

    return res.json({
      success: true,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      amount: amountInPaise,
      currency: "INR",
      razorpayOrderId: razorpayOrder.id,
      localOrderId: order._id,
    });
  } catch (err) {
    console.error("Create order error:", err);
    return res.status(500).json({ error: "Failed to create order" });
  }
});

/**
 * GET /api/orders/webview-checkout
 * Query: { key, amount, currency, razorpayOrderId, localOrderId }
 * Used by the iOS webview checkout flow.
 */
router.get("/orders/webview-checkout", (req, res) => {
  try {
    const key = String(req.query.key || "").trim();
    const amount = Number(req.query.amount || 0);
    const currency = String(req.query.currency || "INR").trim() || "INR";
    const razorpayOrderId = String(req.query.razorpayOrderId || "").trim();
    const localOrderId = String(req.query.localOrderId || "").trim();
    const preferredMethod = String(req.query.preferredMethod || "upi").trim();

    if (!key || !amount || !razorpayOrderId || !localOrderId) {
      return res.status(400).send("Missing payment parameters");
    }

    const callbackUrl = `${req.protocol}://${req.get(
      "host",
    )}/api/orders/verify-webview?localOrderId=${encodeURIComponent(
      localOrderId,
    )}`;

    return res.type("html").send(
      buildRazorpayWebviewCheckoutHtml({
        key,
        amount,
        currency,
        razorpayOrderId,
        localOrderId,
        callbackUrl,
        preferredMethod,
      }),
    );
  } catch (err) {
    console.error("Build webview checkout error:", err);
    return res.status(500).send("Failed to load payment page");
  }
});


/**
 * POST /api/orders/verify
 * Body: { localOrderId, razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * Auth: user (must own the order)
 */
router.post("/orders/verify", authenticateToken, async (req, res) => {
  try {
    const {
      localOrderId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (
      !localOrderId ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({ error: "Missing payment details" });
    }

    const order = await Order.findById(localOrderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.user.toString() !== req.user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const result = await confirmRazorpayOrder({
      order,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (result.statusCode !== 200) {
      return res.status(result.statusCode).json({ error: result.error });
    }

    res.json({ success: true, message: "Payment verified", order });
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({ error: "Failed to verify payment" });
  }
});

router.post("/orders/verify-webview", async (req, res) => {
  try {
    const localOrderId = String(
      req.query.localOrderId || req.body.localOrderId || "",
    ).trim();
    const razorpay_order_id = String(req.body.razorpay_order_id || "").trim();
    const razorpay_payment_id = String(req.body.razorpay_payment_id || "").trim();
    const razorpay_signature = String(req.body.razorpay_signature || "").trim();

    if (!localOrderId) {
      return res
        .type("html")
        .send(
          buildPaymentResultHtml({
            localOrderId: "",
            status: "failed",
            message: "Missing order reference",
          }),
        );
    }

    const order = await Order.findById(localOrderId);
    if (!order) {
      return res
        .type("html")
        .send(
          buildPaymentResultHtml({
            localOrderId,
            status: "failed",
            message: "Order not found",
          }),
        );
    }

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res
        .type("html")
        .send(
          buildPaymentResultHtml({
            localOrderId,
            status: "failed",
            message: "Missing payment details",
          }),
        );
    }

    const result = await confirmRazorpayOrder({
      order,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (result.statusCode === 200 || result.statusCode === 409) {
      return res
        .type("html")
        .send(buildPaymentResultHtml({ localOrderId, status: "success" }));
    }

    return res
      .type("html")
      .send(
        buildPaymentResultHtml({
          localOrderId,
          status: "failed",
          message: result.error || "Payment verification failed",
        }),
      );
  } catch (err) {
    console.error("Webview payment verify error:", err);
    return res
      .status(500)
      .type("html")
      .send(
        buildPaymentResultHtml({
          localOrderId: "",
          status: "failed",
          message: "Payment verification failed",
        }),
      );
  }
});
// Added a new route for failed/dismissed payments
router.post("/orders/payment-failed", authenticateToken, async (req, res) => {
  try {
    const { localOrderId, paymentStatus } = req.body;

    if (!localOrderId) {
      return res.status(400).json({ error: "localOrderId is required" });
    }

    const allowedStatuses = ["FAILED", "CANCELLED"];
    const finalPaymentStatus = allowedStatuses.includes(paymentStatus)
      ? paymentStatus
      : "FAILED";

    const order = await Order.findById(localOrderId);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (order.user.toString() !== req.user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (order.paymentStatus === "PAID") {
      return res.status(409).json({ error: "Paid orders cannot be cancelled" });
    }

    await cancelOrderForPaymentIssue(order, finalPaymentStatus);

    res.json({
      success: true,
      message: `Order marked as ${finalPaymentStatus}`,
      order,
    });
  } catch (err) {
    console.error("Payment failure update error:", err);
    res.status(500).json({ error: "Failed to update payment status" });
  }
});

/**
 * GET /api/orders/me
 * Auth: user
 */
router.get("/orders/me", authenticateToken, async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user.id }).sort({
      createdAt: -1,
    });
    res.json({ orders });
  } catch (err) {
    console.error("Fetch my-orders error:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/**
 * GET /api/admin/orders
 * Auth: admin (role-based)
 */
router.get("/admin/orders", authenticateToken, async (req, res) => {
  try {
    if (!(await isAdmin(req))) {
      return res.status(403).json({ error: "Admin access only" });
    }

    const orders = await Order.find()
      .populate("user", "name phone email society tower flat")
      .sort({ createdAt: -1 });

    res.json({ orders });
  } catch (err) {
    console.error("Admin orders error:", err);
    res.status(500).json({ error: "Failed to fetch admin orders" });
  }
});

/**
 * PATCH /api/admin/orders/:id/status
 * Body: { status }
 * Auth: admin (role-based)
 */
router.patch(
  "/admin/orders/:id/status",
  authenticateToken,
  async (req, res) => {
    try {
      if (!(await isAdmin(req))) {
        return res.status(403).json({ error: "Admin access only" });
      }

      const { status } = req.body;
      const allowed = [
        "PLACED",
        "CONFIRMED",
        "PACKED",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
        "CANCELLED",
      ];

      if (!allowed.includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      // Single null check, in the right place â€” before any mutations
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: "Order not found" });

      const previousStatus = order.orderStatus;

      order.orderStatus = status;
      order.statusTimeline.push({ status, time: new Date() });
      await order.save();

      if (order.orderStatus !== previousStatus) {
        logOrderSummary("Admin updated order:", order);

        await sendOrderStatusNotification(order, status)
          .then((result) => {
            console.log("Customer order notification result:", result);
          })
          .catch((error) => {
            console.error("Customer order notification failed:", error);
          });
      }

      res.json({ success: true, order });

    } catch (err) {
      console.error("Update order status error:", err);
      res.status(500).json({ error: "Failed to update order status" });
    }
  },
);

export default router;

