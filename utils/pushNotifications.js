export async function sendPushToUser({
  userId,
  title,
  body,
  data = {},
  preferenceType = "order",
}) {
  const filter = { user: userId };

  if (preferenceType === "order") {
    filter.orderUpdatesEnabled = true;
  }

  if (preferenceType === "promo") {
    filter.promoEnabled = true;
  }

  const docs = await DeviceToken.find(filter).select("token").lean();
  const tokens = docs.map((doc) => doc.token).filter(Boolean);

  return sendPushToTokens({ tokens, title, body, data });
}
