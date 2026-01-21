import mongoose from "mongoose";

const CartItemSchema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
  selectedSize: { type: Number, required: true },
  quantity: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true, min: 0 },
  name: { type: String, required: true },
  img: { type: String },
});

const CartSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  items: [CartItemSchema],
  updatedAt: { type: Date, default: Date.now },
});

// 🔥 indexes
CartSchema.index({ userId: 1 }, { unique: true });
CartSchema.index({
  userId: 1,
  "items._id": 1,
  "items.selectedSize": 1,
});

const Cart = mongoose.model("Cart", CartSchema);
export default Cart;
