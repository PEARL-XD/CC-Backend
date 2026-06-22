import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import User from "../models/User.js";
import DeviceToken from "../models/DeviceToken.js";
import NotificationReceipt from "../models/NotificationReceipt.js";

function getFirebaseApp() {
  if (getApps().length) return getApps()[0];

  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

function chunk(items, size = 500) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function removeInvalidTokens(failedTokens) {
  if (!failedTokens.length) return;
  await DeviceToken.deleteMany({ token: { $in: failedTokens } });
}

function normalizeData(data = {}) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, String(value)]),
  );
}

export async function sendPushToTokens({ tokens, title, body, data = {} }) {
  if (!tokens?.length) {
    return {
      successCount: 0,
      failureCount: 0,
      successTokens: [],
      failureTokens: [],
    };
  }

  getFirebaseApp();
  const messaging = getMessaging();
  const failedTokens = [];
  const successTokens = [];
  let successCount = 0;
  let failureCount = 0;

  for (const tokenBatch of chunk(tokens, 500)) {
    const response = await messaging.sendEachForMulticast({
      tokens: tokenBatch,
      notification: { title, body },
      data: normalizeData(data),
      android: {
        priority: "high",
        notification: {
          channelId: "cleanchops_high_importance",
        },
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
          },
        },
      },
    });

    successCount += response.successCount;
    failureCount += response.failureCount;

    response.responses.forEach((result, index) => {
      if (!result.success) {
        const code = result.error?.code || "";
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-registration-token")
        ) {
          failedTokens.push(tokenBatch[index]);
        }
      } else {
        successTokens.push(tokenBatch[index]);
      }
    });
  }

  await removeInvalidTokens(failedTokens);

  return {
    successCount,
    failureCount,
    successTokens,
    failureTokens: failedTokens,
  };
}

export async function sendPushToUser({
  userId,
  title,
  body,
  data = {},
  preferenceType = "order",
}) {
  const filter = { user: userId };

  if (preferenceType === "order") {
    filter.orderUpdatesEnabled = { $ne: false };
  }

  if (preferenceType === "promo") {
    filter.promoEnabled = { $ne: false };
  }

  const docs = await DeviceToken.find(filter).select("token").lean();
  const tokens = docs.map((doc) => doc.token).filter(Boolean);

  return sendPushToTokens({ tokens, title, body, data });
}

export async function sendPushToAdmins({
  title,
  body,
  data = {},
}) {
  const adminUsers = await User.find({ role: "admin" }).select("_id").lean();
  const adminIds = adminUsers.map((user) => user._id).filter(Boolean);

  if (!adminIds.length) {
    return { successCount: 0, failureCount: 0 };
  }

  const docs = await DeviceToken.find({ user: { $in: adminIds } })
    .select("token")
    .lean();
  const tokens = docs.map((doc) => doc.token).filter(Boolean);

  return sendPushToTokens({ tokens, title, body, data });
}

export async function sendPromoBroadcast({ title, body, route = "/home" }) {
  const docs = await DeviceToken.find({ promoEnabled: { $ne: false } })
    .select("token user platform")
    .lean();
  const uniqueDocs = [];
  const seen = new Set();

  for (const doc of docs) {
    const token = doc.token?.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    uniqueDocs.push(doc);
  }

  const notificationId = `promo_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const tokens = uniqueDocs.map((doc) => doc.token).filter(Boolean);

  const result = await sendPushToTokens({
    tokens,
    title,
    body,
    data: {
      type: "promo",
      notificationId,
      route,
    },
  });

  if (result.successTokens.length) {
    const tokenToDoc = new Map(uniqueDocs.map((doc) => [doc.token, doc]));

    await NotificationReceipt.insertMany(
      result.successTokens
        .map((token) => {
        const recipient = tokenToDoc.get(token);
        if (!recipient) return null;
        return {
          notificationId,
          user: recipient.user,
          token,
          platform: recipient.platform,
          type: "promo",
          route,
          title,
          body,
          status: "SENT",
          sentAt: new Date(),
        };
      })
        .filter(Boolean),
      { ordered: false },
    ).catch(() => {});
  }

  return {
    ...result,
    notificationId,
    targetCount: tokens.length,
  };
}
