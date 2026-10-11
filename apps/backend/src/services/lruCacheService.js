/**
 * High-Performance In-Memory LRU Cache with TTL Expiry for VAAYU Logistics Engine
 * Provides < 1 ms cache lookups for Geocoding, Distance Matrix, and Fare Estimation.
 */

class LruCacheService {
  constructor(capacity = 5000, defaultTtlMs = 3600000) {
    this.capacity = capacity;
    this.defaultTtlMs = defaultTtlMs;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    if (!this.cache.has(key)) {
      this.misses++;
      return null;
    }

    const item = this.cache.get(key);
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Refresh LRU order (delete & re-insert)
    this.cache.delete(key);
    this.cache.set(key, item);
    this.hits++;

    return item.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Evict oldest item (first key in Map iterator)
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    });
  }

  has(key) {
    return this.get(key) !== null;
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats() {
    return {
      size: this.cache.size,
      capacity: this.capacity,
      hits: this.hits,
      misses: this.misses,
      hitRatio: (this.hits + this.misses) > 0 ? (this.hits / (this.hits + this.misses)).toFixed(4) : 0
    };
  }
}

const geoCache = new LruCacheService(5000, 3600000);  // 1 hour TTL
const fareCache = new LruCacheService(3000, 1800000); // 30 min TTL

module.exports = {
  LruCacheService,
  geoCache,
  fareCache
};
