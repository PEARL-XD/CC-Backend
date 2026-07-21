import express from "express";
import { authenticateToken, authLimiter } from "./auth.js";
import Cart from "../models/Cart.js";
import Item from "../models/Item.js";
import StorefrontSettings from "../models/StorefrontSettings.js";
import {
  findItemByIdFlexible,
  findItemsByIdsFlexible,
} from "../utils/itemLookup.js";
import {
  getAllowedSizesForItem,
  getPackPriceForItem,
  normalizePackSize,
  normalizePricingMode,
} from "../utils/packPricing.js";

const router = express.Router();
router.use(authLimiter);

const CART_ITEM_LIMIT = 50;
const MAX_QUANTITY = 99;

/* ---------------- HELPERS ---------------- */

async function getCart(userId) {
  let cart = await Cart.findOne({ userId });
  if (!cart) {
    cart = await Cart.create({ userId, items: [] });
  }
  return cart;
}

async function hydrateCartItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const ids = [
    ...new Set(items.map((item) => item?._id?.toString?.()).filter(Boolean)),
  ];

  const products = ids.length ? await findItemsByIdsFlexible(ids) : [];

  const productMap = new Map(
    products.map((product) => [product._id.toString(), product]),
  );

  return items.map((item) => {
    const plain = typeof item?.toObject === "function" ? item.toObject() : item;
    const rawId = plain?._id?.toString?.() ?? String(plain?._id ?? "");
    const product = productMap.get(rawId);
    const selectedSize =
      normalizePackSize(plain?.selectedSize) ??
      Number(plain?.selectedSize ?? 0);

    if (!product) {
      return {
        ...plain,
        selectedSize,
      };
    }

    return {
      ...plain,
      _id: product._id,
      name: product.name,
      img: product.imgUrl,
      category: product.category,
      cutInstruction: plain?.cutInstruction?.toString?.() ?? plain?.cutInstruction,
      selectedSize,
      price: getPackPriceForItem(product, selectedSize),
    };
  });
}

function validateItemInput(res, { _id, quantity }) {
  if (!_id) {
    res.status(400).json({ error: "Invalid item" });
    return false;
  }
  if (quantity !== undefined) {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
      res
        .status(400)
        .json({ error: `Quantity must be between 1 and ${MAX_QUANTITY}` });
      return false;
    }
  }
  return true;
}

/* ---------------- READ ---------------- */

router.get("/cart", authenticateToken, async (req, res) => {
  try {
    const cart = await getCart(req.user.id);
    const cartItems = await hydrateCartItems(cart.items);
    res.json({ cart: cartItems });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch cart" });
  }
});

/* ---------------- MUTATIONS ---------------- */

// ADD ITEM
router.post("/cart/add", authenticateToken, async (req, res) => {
  try {
    const { _id, selectedSize, quantity = 1, cutInstruction = "" } = req.body;

    const normalizedSize = Number(selectedSize);
    const qty = Number(quantity);

    if (!validateItemInput(res, { _id, quantity })) {
      return;
    }

    const product = await findItemByIdFlexible(_id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    const mode = normalizePricingMode(product);
    const resolvedSize = mode === "single" ? 0 : normalizedSize;
    const allowedSizes = getAllowedSizesForItem(product);

    if (mode !== "single" && !allowedSizes.includes(resolvedSize)) {
      return res.status(400).json({ error: "Invalid selected size" });
    }

    if (product.isOutOfStock === true) {
      return res.status(400).json({
        error: `${product.name} is currently out of stock`,
      });
    }

    const settings = await StorefrontSettings.findOne({
      key: "storefront",
    }).lean();

    const cookedEnabled = settings?.cookedEnabled ?? true;
    const isCooked = mode === "cooked";

    if (isCooked && !cookedEnabled) {
      return res.status(400).json({
        error: "Cooked food is coming soon to your society.",
      });
    }

    const userId = req.user.id;
    const cart = await getCart(userId);

    const idx = cart.items.findIndex(
      (i) => i._id.toString() === _id && i.selectedSize === resolvedSize,
    );

    if (idx !== -1) {
      const newQty = cart.items[idx].quantity + qty;

      if (newQty > MAX_QUANTITY) {
        return res.status(400).json({
          error: `Cannot exceed ${MAX_QUANTITY} of the same item`,
        });
      }

      cart.items[idx].quantity = newQty;
      cart.items[idx].name = product.name;
      cart.items[idx].img = product.imgUrl;
      cart.items[idx].category = product.category;
      cart.items[idx].cutInstruction = String(cutInstruction || "").trim();
    } else {
      if (cart.items.length >= CART_ITEM_LIMIT) {
        return res.status(400).json({ error: "Cart limit reached" });
      }

      cart.items.push({
        _id,
        selectedSize: resolvedSize,
        quantity: qty,
        name: product.name,
        img: product.imgUrl,
        category: product.category,
        cutInstruction: String(cutInstruction || "").trim(),
      });
    }

    cart.items = await hydrateCartItems(cart.items);
    await cart.save();
    return res.json({ cart: cart.items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to add item" });
  }
});

// REMOVE ITEM
router.post("/cart/remove", authenticateToken, async (req, res) => {
  try {
    const { _id, selectedSize, cutInstruction = "" } = req.body;

    if (!_id || selectedSize === undefined) {
      return res.status(400).json({ error: "Invalid item" });
    }

    const cart = await getCart(req.user.id);

    cart.items = cart.items.filter(
      (i) =>
        !(
          i._id.toString() === _id &&
          i.selectedSize === Number(selectedSize) &&
          String(i.cutInstruction || "") === String(cutInstruction || "").trim()
        ),
    );

    await cart.save();
    res.json({ cart: cart.items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to remove item" });
  }
});

// UPDATE QUANTITY
router.post("/cart/update", authenticateToken, async (req, res) => {
  try {
    const { _id, selectedSize, quantity, cutInstruction = "" } = req.body;

    if (!validateItemInput(res, { _id, quantity })) {
      return;
    }

    const product = await findItemByIdFlexible(_id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    const normalizedSize = Number(selectedSize);
    const mode = normalizePricingMode(product);
    const resolvedSize = mode === "single" ? 0 : normalizedSize;
    if (mode !== "single" && !getAllowedSizesForItem(product).includes(resolvedSize)) {
      return res.status(400).json({ error: "Invalid selected size" });
    }

    const cart = await getCart(req.user.id);

    const item = cart.items.find(
      (i) =>
        i._id.toString() === _id &&
        i.selectedSize === resolvedSize &&
        String(i.cutInstruction || "") === String(cutInstruction || "").trim(),
    );

    if (!item) return res.status(404).json({ error: "Item not found" });

    item.quantity = Number(quantity);
    item.category = product.category;
    if (typeof req.body.cutInstruction === "string") {
      item.cutInstruction = req.body.cutInstruction.trim();
    }
    cart.items = await hydrateCartItems(cart.items);
    await cart.save();
    res.json({ cart: cart.items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update quantity" });
  }
});

// CLEAR CART
router.post("/cart/clear", authenticateToken, async (req, res) => {
  try {
    const cart = await getCart(req.user.id);
    cart.items = [];
    await cart.save();
    res.json({ cart: [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to clear cart" });
  }
});

export default router;
