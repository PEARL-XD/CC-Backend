import express from "express";
import { authenticateToken, authLimiter } from "./auth.js"; // adjust relative path if needed
import Cart from "../models/Cart.js"; // create this Mongoose model as shown earlier

const router = express.Router();

// Apply authLimiter to all cart routes
router.use(authLimiter);

// GET /cart - get current user's cart items
router.get("/cart", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return res.json({ cart: [] }); // no cart found, return empty array
    }

    res.json({ cart: cart.items });
  } catch (err) {
    console.error("Error fetching cart:", err);
    res.status(500).json({ error: "Server error fetching cart" });
  }
});

// POST /cart - update/save user's cart items
router.post("/cart", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { cart } = req.body;

    if (!Array.isArray(cart)) {
      return res.status(400).json({ error: "Cart must be an array" });
    }
    // Basic validation of cart items
    for (const item of cart) {
      if (
        !item._id ||
        typeof item.selectedSize !== "number" ||
        !(item.quantity > 0) ||
        typeof item.price !== "number" ||
        item.price < 0 ||
        typeof item.name !== "string"
      ) {
        return res.status(400).json({ error: "Invalid cart item format" });
      }
    }
    // Upsert user's cart
    const updatedCart = await Cart.findOneAndUpdate(
      { userId },
      { items: cart, updatedAt: new Date() },
      { new: true, upsert: true }
    );

    res.json({ message: "Cart saved successfully." });
  } catch (err) {
    console.error("Error saving cart:", err);
    res.status(500).json({ error: "Server error saving cart" });
  }
});

export default router;
