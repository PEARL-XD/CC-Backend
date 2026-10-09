// Only for public catalogue/settings data, never user, cart, or payment data.
export class PublicReadCache {
  constructor({ maxEntries = 256, ttlMs = 60_000, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
    this.pending = new Map();
    this.generation = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    const now = this.now();
    for (const [entryKey, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(entryKey);
    }
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  async getOrLoad(key, load) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    if (this.pending.has(key)) return this.pending.get(key);

    const generation = this.generation;
    const request = Promise.resolve().then(load);
    this.pending.set(key, request);
    try {
      const value = await request;
      // An admin edit must not be undone by an older, slower read.
      if (generation === this.generation) this.set(key, value);
      return value;
    } finally {
      if (this.pending.get(key) === request) this.pending.delete(key);
    }
  }

  clear() {
    this.generation += 1;
    this.entries.clear();
    this.pending.clear();
  }
}
