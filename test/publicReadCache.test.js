import test from "node:test";
import assert from "node:assert/strict";
import { PublicReadCache } from "../utils/publicReadCache.js";

test("bounded LRU entries expire even when their search is never repeated", () => {
  let now = 0;
  const cache = new PublicReadCache({ maxEntries: 2, ttlMs: 100, now: () => now });
  cache.set("a", []);
  cache.set("b", [1]);
  assert.deepEqual(cache.get("a"), []);
  cache.set("c", [2]);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.entries.size, 2);
  now = 100;
  cache.set("d", [3]);
  assert.equal(cache.entries.size, 1);
  assert.equal(cache.get("a"), undefined);
  now = 200;
  assert.equal(cache.get("d"), undefined);
});

test("simultaneous public reads share one load; empty results are cached", async () => {
  const cache = new PublicReadCache();
  let calls = 0;
  const load = async () => { calls++; return []; };
  const results = await Promise.all(Array.from({ length: 20 }, () => cache.getOrLoad("a", load)));
  assert.equal(calls, 1);
  assert.ok(results.every((value) => Array.isArray(value) && value.length === 0));
  await cache.getOrLoad("a", load);
  assert.equal(calls, 1);
  assert.equal(cache.pending.size, 0);
});

test("failures are not cached and subsequent requests can retry", async () => {
  const cache = new PublicReadCache();
  await assert.rejects(cache.getOrLoad("a", () => { throw Error("offline"); }), /offline/);
  assert.equal(cache.pending.size, 0);
  assert.equal(await cache.getOrLoad("a", async () => "recovered"), "recovered");
});

test("cache hits do not extend freshness and expired data is reloaded", async () => {
  let now = 0;
  let calls = 0;
  const cache = new PublicReadCache({ ttlMs: 100, now: () => now });
  const load = async () => ++calls;
  assert.equal(await cache.getOrLoad("a", load), 1);
  now = 99;
  assert.equal(await cache.getOrLoad("a", load), 1);
  now = 100;
  assert.equal(await cache.getOrLoad("a", load), 2);
});

test("admin invalidation prevents old reads overwriting or joining new reads", async () => {
  const cache = new PublicReadCache();
  let finishOld;
  let finishNew;
  const old = cache.getOrLoad("a", () => new Promise((resolve) => { finishOld = resolve; }));
  await Promise.resolve();
  cache.clear();
  const fresh = cache.getOrLoad("a", () => new Promise((resolve) => { finishNew = resolve; }));
  await Promise.resolve();
  finishOld("old");
  assert.equal(await old, "old");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.pending.size, 1);
  finishNew("new");
  assert.equal(await fresh, "new");
  assert.equal(cache.get("a"), "new");
});
