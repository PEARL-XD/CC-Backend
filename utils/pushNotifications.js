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

function personalizeText(template = "", user = {}) {
  const replacements = {
    "{{name}}": user.name || "there",
    "{{phone}}": user.phone || "",
    "{{society}}": user.society || "",
    "{{tower}}": user.tower || "",
    "{{floor}}": user.floor || "",
    "{{flat}}": user.flat || "",
  };

  let text = String(template || "");
  for (const [needle, replacement] of Object.entries(replacements)) {
    text = text.replaceAll(needle, replacement);
  }
  return text;
}

function dedupeTokenDocs(docs = []) {
  const uniqueDocs = [];
  const seen = new Set();

  for (const doc of docs) {
    const token = doc.token?.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    uniqueDocs.push(doc);
  }

  return uniqueDocs;
}

async function sendPersonalizedPromoNotifications({
  docs = [],
  users = [],
  title,
  body,
  route = "/home",
  notificationId = `promo_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
}) {
  const uniqueDocs = dedupeTokenDocs(docs);
  const tokenToUser = new Map(users.map((user) => [user._id.toString(), user]));
  const successTokens = [];
  const failureTokens = [];

  for (const doc of uniqueDocs) {
    const token = doc.token?.trim();
    if (!token) continue;

    const user = tokenToUser.get(doc.user?.toString?.() || "");
    if (!user) {
      failureTokens.push(token);
      continue;
    }

    const result = await sendPersonalizedPush({
      token,
      user,
      title,
      body,
      route,
      notificationType: "promo",
    });

    if (result.success) {
      successTokens.push(token);
    } else {
      failureTokens.push(token);
    }
  }

  if (successTokens.length) {
    const tokenToDoc = new Map(uniqueDocs.map((doc) => [doc.token, doc]));

    await NotificationReceipt.insertMany(
      successTokens
        .map((token) => {
          const recipient = tokenToDoc.get(token);
          if (!recipient) return null;
          const user = tokenToUser.get(recipient.user?.toString?.() || "");
          if (!user) return null;

          return {
            notificationId,
            user: recipient.user,
            token,
            platform: recipient.platform,
            type: "promo",
            route,
            title: personalizeText(title, user),
            body: personalizeText(body, user),
            status: "SENT",
            sentAt: new Date(),
          };
        })
        .filter(Boolean),
      { ordered: false },
    ).catch(() => {});
  }

  return {
    successCount: successTokens.length,
    failureCount: failureTokens.length,
    successTokens,
    failureTokens,
    notificationId,
    targetCount: uniqueDocs.length,
  };
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

async function sendPersonalizedPush({
  token,
  user,
  title,
  body,
  data = {},
  notificationType = "promo",
  route = "/home",
}) {
  getFirebaseApp();
  const messaging = getMessaging();

  const personalizedTitle = personalizeText(title, user);
  const personalizedBody = personalizeText(body, user);

  try {
    const response = await messaging.send({
      token,
      notification: {
        title: personalizedTitle,
        body: personalizedBody,
      },
      data: normalizeData({
        ...data,
        type: notificationType,
        route,
      }),
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

    return {
      success: true,
      messageId: response,
      title: personalizedTitle,
      body: personalizedBody,
    };
  } catch (error) {
    const code = error?.code || "";
    if (
      code.includes("registration-token-not-registered") ||
      code.includes("invalid-registration-token")
    ) {
      await DeviceToken.deleteMany({ token });
    }

    return {
      success: false,
      error,
      title: personalizedTitle,
      body: personalizedBody,
    };
  }
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
  const uniqueDocs = dedupeTokenDocs(docs);
  const userIds = [
    ...new Set(
      uniqueDocs
        .map((doc) => doc.user?.toString?.())
        .filter(Boolean),
    ),
  ];

  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } })
        .select("_id name phone society tower floor flat")
        .lean()
    : [];

  return sendPersonalizedPromoNotifications({
    docs: uniqueDocs,
    users,
    title,
    body,
    route,
  });
}

export async function sendTargetedPromoNotification({
  title,
  body,
  route = "/home",
  userQuery = {},
  users: providedUsers = [],
}) {
  const users = Array.isArray(providedUsers) && providedUsers.length
    ? providedUsers
    : await User.find({
        ...userQuery,
        ...(Object.keys(userQuery).length === 0 ? { role: { $ne: "admin" } } : {}),
      })
        .select("_id name phone society tower floor flat")
        .lean();

  if (!users.length) {
    return {
      successCount: 0,
      failureCount: 0,
      successTokens: [],
      failureTokens: [],
      notificationId: null,
      targetCount: 0,
    };
  }

  const userIds = users.map((user) => user._id).filter(Boolean);
  const docs = await DeviceToken.find({
    user: { $in: userIds },
    promoEnabled: { $ne: false },
  })
    .select("token user platform")
    .lean();
  return sendPersonalizedPromoNotifications({
    docs,
    users,
    title,
    body,
    route,
  });
}
