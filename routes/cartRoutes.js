import express from "express";
import { authenticateToken, authLimiter } from "./auth.js";
import Cart from "../models/Cart.js";

const router = express.Router();
router.use(authLimiter);

/* ---------------- HELPERS ---------------- */

async function getCart(userId) {
  let cart = await Cart.findOne({ userId });
  if (!cart) {
    cart = await Cart.create({ userId, items: [] });
  }
  return cart;
}

/* ---------------- READ ---------------- */

router.get("/cart", authenticateToken, async (req, res) => {
  try {
    const cart = await Cart.findOne({ userId: req.user.id });
    res.json({ cart: cart?.items ?? [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch cart" });
  }
});

/* ---------------- MUTATIONS ---------------- */

// ADD ITEM
router.post("/cart/add", authenticateToken, async (req, res) => {
  try {
    const { _id, selectedSize, quantity = 1, price, name, img } = req.body;
    const userId = req.user.id;

    if (!_id || typeof selectedSize !== "number") {
      return res.status(400).json({ error: "Invalid item" });
    }

    const cart = await getCart(userId);

    const idx = cart.items.findIndex(
      (i) => i._id.toString() === _id && i.selectedSize === selectedSize
    );

    if (idx !== -1) {
      cart.items[idx].quantity += Number(quantity);
    } else {
      cart.items.push({
        _id,
        selectedSize,
        quantity: Number(quantity),
        price,
        name,
        img,
      });
    }

    cart.updatedAt = new Date();
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
    const cart = await getCart(req.user.id);

    cart.items = cart.items.filter(
      (i) => !(i._id.toString() === _id && i.selectedSize === selectedSize)
    );

    cart.updatedAt = new Date();
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
    const cart = await getCart(req.user.id);

    const item = cart.items.find(
      (i) => i._id.toString() === _id && i.selectedSize === selectedSize
    );

    if (!item) return res.status(404).json({ error: "Item not found" });
    if (quantity < 1) return res.status(400).json({ error: "Invalid quantity" });

    item.quantity = Number(quantity);
    cart.updatedAt = new Date();
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
    cart.updatedAt = new Date();
    await cart.save();
    res.json({ cart: [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to clear cart" });
  }
});

export default router;
