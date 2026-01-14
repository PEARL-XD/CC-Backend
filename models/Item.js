import mongoose from "mongoose";

const itemSchema = new mongoose.Schema({
  category: { type: String, required: true },
  name: { type: String, required: true },
  desc: { type: String },
  longdesc: { type: String },
  price: { type: Number },
  oldprice: { type: Number },
  imgUrl: { type: String },
  proteinPer100g:{type: String},
  carbsPer100g:{type: String},
  caloriesPer100g:{type: String}
});

const Item = mongoose.model("Item", itemSchema);

export default Item;
