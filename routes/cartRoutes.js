import express from "express";
import { authenticateToken, authLimiter } from "./auth.js";
import Cart from "../models/Cart.js";
import Product from "../models/Product.js"; // ← needed to verify price server-side

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

function validateItemInput(res, { _id, selectedSize, quantity }) {
  if (!_id || typeof selectedSize !== "number") {
    res.status(400).json({ error: "Invalid item" });
    return false;
  }
  if (quantity !== undefined) {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
      res.status(400).json({ error: `Quantity must be between 1 and ${MAX_QUANTITY}` });
      return false;
    }
  }
  return true;
}

/* ---------------- READ ---------------- */

router.get("/cart", authenticateToken, async (req, res) => {
  try {
    // Use getCart so a first-time user always gets a proper document
    const cart = await getCart(req.user.id);
    res.json({ cart: cart.items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch cart" });
  }
});

/* ---------------- MUTATIONS ---------------- */

// ADD ITEM
router.post("/cart/add", authenticateToken, async (req, res) => {
  try {
    const { _id, selectedSize, quantity = 1 } = req.body;

    // 1. Validate input shape and quantity bounds
    if (!validateItemInput(res, { _id, selectedSize: Number(selectedSize), quantity })) return;

    // 2. Fetch canonical product data — never trust client-supplied price/name
    const product = await Product.findById(_id).lean();
    if (!product) return res.status(404).json({ error: "Product not found" });

    const userId = req.user.id;
    const cart = await getCart(userId);

    const normalizedSize = Number(selectedSize);
    const qty = Number(quantity);

    const idx = cart.items.findIndex(
      (i) => i._id.toString() === _id && i.selectedSize === normalizedSize
    );

    if (idx !== -1) {
      const newQty = cart.items[idx].quantity + qty;
      if (newQty > MAX_QUANTITY) {
        return res.status(400).json({ error: `Cannot exceed ${MAX_QUANTITY} of the same item` });
      }
      cart.items[idx].quantity = newQty;
    } else {
      // 3. Guard cart size
      if (cart.items.length >= CART_ITEM_LIMIT) {
        return res.status(400).json({ error: "Cart limit reached" });
      }
      cart.items.push({
        _id,
        selectedSize: normalizedSize,
        quantity: qty,
        price: product.price,   // ← from DB, not req.body
        name: product.name,     // ← from DB, not req.body
        img: product.img,       // ← from DB, not req.body
      });
    }

    await cart.save();
    res.json({ cart: cart.items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add item" });
  }
});

// REMOVE ITEM
router.post("/cart/remove", authenticateToken, async (req, res) => {
  try {
    const { _id, selectedSize } = req.body;

    // Validate presence of required fields before doing anything
    if (!_id || selectedSize === undefined) {
      return res.status(400).json({ error: "Invalid item" });
    }

    const cart = await getCart(req.user.id);

    cart.items = cart.items.filter(
      (i) => !(i._id.toString() === _id && i.selectedSize === Number(selectedSize))
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
    const { _id, selectedSize, quantity } = req.body;

    // Validate before any DB work
    if (!validateItemInput(res, { _id, selectedSize: Number(selectedSize), quantity })) return;

    const cart = await getCart(req.user.id);

    const item = cart.items.find(
      (i) => i._id.toString() === _id && i.selectedSize === Number(selectedSize)
    );

    if (!item) return res.status(404).json({ error: "Item not found" });

    item.quantity = Number(quantity);
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