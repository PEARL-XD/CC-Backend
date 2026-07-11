import mongoose from "mongoose";
import Item from "../models/Item.js";

function normalizeId(id) {
  return String(id || "").trim();
}

export async function findItemByIdFlexible(id) {
  const rawId = normalizeId(id);
  if (!rawId) return null;

  const direct = await Item.collection.findOne({ _id: rawId });
  if (direct) return direct;

  if (mongoose.Types.ObjectId.isValid(rawId)) {
    const objectId = new mongoose.Types.ObjectId(rawId);
    return Item.collection.findOne({ _id: objectId });
  }

  return null;
}

export async function findItemsByIdsFlexible(ids) {
  const rawIds = [...new Set((ids || []).map(normalizeId).filter(Boolean))];
  if (!rawIds.length) return [];

  const objectIds = rawIds.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));

  const queryParts = [];
  if (rawIds.length) {
    queryParts.push({ _id: { $in: rawIds } });
  }
  if (objectIds.length) {
    queryParts.push({ _id: { $in: objectIds } });
  }

  if (!queryParts.length) return [];
  if (queryParts.length === 1) {
    return Item.collection.find(queryParts[0]).toArray();
  }

  return Item.collection.find({ $or: queryParts }).toArray();
}
