import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Item from "../models/Item.js";
import StorefrontSettings from "../models/StorefrontSettings.js";
import router, { clearItemsCache } from "../routes/itemsRoutes.js";
import {
  getStorefrontSettings,
  clearStorefrontSettingsCache,
  buildStorefrontSettingsPayload,
} from "../utils/storefrontSettingsCache.js";

test("public endpoints keep mobile/web payloads and invalidate after admin changes", async (t) => {
  let settingsReads = 0;
  let itemReads = 0;
  let settings = { storeOpen: false, packagingFee: 5, serviceableSocieties: ["Legacy Society"] };
  let product = {
    _id: "legacy-string-id", name: "Chicken", desc: "Fresh chicken",
    category: "Uncooked", price: 200, imgUrl: "/chicken.png",
  };
  t.mock.method(StorefrontSettings, "findOne", () => ({
    lean: async () => { settingsReads++; return settings; },
  }));
  t.mock.method(Item, "find", () => {
    const query = {
      select: () => query,
      sort: () => query,
      limit: () => query,
      lean: async () => {
        itemReads++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [product];
      },
    };
    return query;
  });
  clearItemsCache();
  clearStorefrontSettingsCache();
  const app = express();
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
    clearItemsCache();
    clearStorefrontSettingsCache();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const read = async (path) => {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    return response.json();
  };

  const startup = await Promise.all([
    read("/items"), read("/items"), read("/storefront"), read("/storefront"),
  ]);
  assert.equal(itemReads, 1);
  assert.equal(settingsReads, 1);
  assert.deepEqual(startup[0], startup[1]);
  assert.deepEqual(startup[2], { settings: buildStorefrontSettingsPayload(settings) });
  const section = startup[0][0];
  assert.equal(section.title, "Uncooked");
  assert.equal(section.imageAsset, "assets/images/raw.png");
  const item = section.articles[0];
  assert.equal(item._id, "legacy-string-id");
  assert.equal(item.price, 200);
  assert.equal(item.img, "/chicken.png");
  assert.equal(item.isUnavailable, false);
  assert.ok(Array.isArray(item.pricingOptions));
  const cached = await fetch(`${base}/items`);
  assert.equal(cached.headers.get("x-cache"), "HIT");
  assert.deepEqual(await cached.json(), startup[0]);

  const searches = await Promise.all([read("/items/search?q=Chicken"), read("/items/search?q=Chicken")]);
  assert.equal(itemReads, 2);
  assert.deepEqual(searches[0], searches[1]);
  assert.equal(searches[0].items[0]._id, product._id);
  await read("/items/search?q=chicken");
  assert.equal(itemReads, 2);
  assert.deepEqual(await read("/items/search?q=c"), { items: [] });

  product = { ...product, price: 225, isOutOfStock: true };
  settings = { ...settings, storeOpen: true };
  clearItemsCache();
  clearStorefrontSettingsCache();
  const refreshed = await read("/items");
  assert.equal(refreshed[0].articles[0].price, 225);
  assert.equal(refreshed[0].articles[0].isUnavailable, true);
  assert.equal((await read("/storefront")).settings.storeOpen, true);
  assert.equal(itemReads, 3);
  assert.equal(settingsReads, 2);
});

test("settings coalescing preserves legacy polygon fields and empty-database defaults", async (t) => {
  let reads = 0;
  let data = {
    serviceAreaPolygon: [
      { latitude: 28, longitude: 77 },
      { latitude: 29, longitude: 77 },
      { latitude: 29, longitude: 78 },
    ],
    serviceableSocieties: ["Legacy Society"],
  };
  t.mock.method(StorefrontSettings, "findOne", () => ({
    lean: async () => { reads++; return data; },
  }));
  clearStorefrontSettingsCache();
  t.after(clearStorefrontSettingsCache);
  const values = await Promise.all(Array.from({ length: 10 }, () => getStorefrontSettings()));
  assert.equal(reads, 1);
  assert.deepEqual(values[0], buildStorefrontSettingsPayload(data));
  assert.deepEqual(values[0].serviceAreaPolygon, data.serviceAreaPolygon);
  assert.deepEqual(values[0].serviceableSocieties, ["Legacy Society"]);
  data = null;
  clearStorefrontSettingsCache();
  assert.deepEqual(await getStorefrontSettings(), buildStorefrontSettingsPayload(null));
  assert.equal(reads, 2);
});
