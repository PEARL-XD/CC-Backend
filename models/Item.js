import mongoose from "mongoose";

const itemSchema = new mongoose.Schema({
  category: { type: String, required: true },
  name: { type: String, required: true },
  desc: { type: String },
  longdesc: { type: String },
  price: { type: Number },
  oldprice: { type: Number },
  pricingOptions: [
    {
      size: { type: Number },
      label: { type: String },
      rangeLabel: { type: String },
      price: { type: Number },
    },
  ],
  cookedQuarterPrice: { type: Number },
  cookedHalfPrice: { type: Number },
  cookedFullPrice: { type: Number },
  rtc200Price: { type: Number },
  rtc400Price: { type: Number },
  isExternalItem: { type: Boolean, default: false },
  showSourceNotice: { type: Boolean, default: false },
  sourceNoticeTitle: { type: String },
  sourceNoticeMessage: { type: String },
  sourceLabel: { type: String },
  sourceUrl: { type: String },
  imgUrl: { type: String },
  proteinPer100g: { type: String },
  carbsPer100g: { type: String },
  caloriesPer100g: { type: String },
  isOutOfStock: { type: Boolean, default: false },
});

const Item = mongoose.model("Item", itemSchema);

export default Item;
