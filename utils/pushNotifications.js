import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import DeviceToken from "../models/DeviceToken.js";

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
    return { successCount: 0, failureCount: 0 };
  }

  getFirebaseApp();
  const messaging = getMessaging();
  const failedTokens = [];
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
      }
    });
  }

  await removeInvalidTokens(failedTokens);

  return { successCount, failureCount };
}

export async function sendPushToUser({ userId, title, body, data = {} }) {
  const docs = await DeviceToken.find({ user: userId }).select("token").lean();
  const tokens = docs.map((doc) => doc.token).filter(Boolean);

  return sendPushToTokens({ tokens, title, body, data });
}

export async function sendPromoBroadcast({ title, body, route = "/home" }) {
  const docs = await DeviceToken.find().select("token").lean();
  const tokens = [...new Set(docs.map((doc) => doc.token).filter(Boolean))];

  return sendPushToTokens({
    tokens,
    title,
    body,
    data: {
      type: "promo",
      route,
    },
  });
}
