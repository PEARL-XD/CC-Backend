import mongoose from "mongoose";

const itemSchema = new mongoose.Schema({
  category: { type: String, required: true },
  name: { type: String, required: true },
  desc: { type: String },
  longdesc: { type: String },
  price: { type: Number },
  oldprice: { type: Number },
  cookedQuarterPrice: { type: Number },
  cookedHalfPrice: { type: Number },
  cookedFullPrice: { type: Number },
  rtc200Price: { type: Number },
  rtc400Price: { type: Number },
  imgUrl: { type: String },
  proteinPer100g: { type: String },
  carbsPer100g: { type: String },
  caloriesPer100g: { type: String },
  isOutOfStock: { type: Boolean, default: false },
});

const Item = mongoose.model("Item", itemSchema);

export default Item;
