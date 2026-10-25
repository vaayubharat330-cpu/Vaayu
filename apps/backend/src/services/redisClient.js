const EventEmitter = require('events');

class RedisMemoryEngine extends EventEmitter {
  constructor() {
    super();
    this.hashes = new Map();
    this.strings = new Map();
    this.sets = new Map();
    this.lists = new Map();
    this.geo = new Map();
    this.expiry = new Map();
    this.subscriptions = new Map();
  }

  _checkExpiry(key) {
    const expiresAt = this.expiry.get(key);
    if (expiresAt && Date.now() >= expiresAt) {
      this.expiry.delete(key);
      this.hashes.delete(key);
      this.strings.delete(key);
      this.sets.delete(key);
      this.lists.delete(key);
      this.geo.delete(key);
    }
  }

  async get(key) { this._checkExpiry(key); return this.strings.get(key) ?? null; }
  async set(key, value, ...args) {
    this.strings.set(key, String(value));
    const exIndex = args.findIndex(a => String(a).toUpperCase() === 'EX');
    if (exIndex >= 0 && args[exIndex + 1] != null) this.expiry.set(key, Date.now() + Number(args[exIndex + 1]) * 1000);
    return 'OK';
  }
  async del(key) {
    const existed = this.hashes.delete(key) || this.strings.delete(key) || this.sets.delete(key) || this.lists.delete(key) || this.geo.delete(key);
    this.expiry.delete(key);
    return existed ? 1 : 0;
  }
  async exists(key) { this._checkExpiry(key); return (this.hashes.has(key) || this.strings.has(key) || this.sets.has(key) || this.lists.has(key) || this.geo.has(key)) ? 1 : 0; }
  async sadd(key, member) {
    this._checkExpiry(key);
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const set = this.sets.get(key);
    const before = set.size;
    set.add(String(member));
    return set.size > before ? 1 : 0;
  }
  async smembers(key) { this._checkExpiry(key); return [...(this.sets.get(key) || [])]; }
  async srem(key, member) { this._checkExpiry(key); const set = this.sets.get(key); if (!set) return 0; return set.delete(String(member)) ? 1 : 0; }
  async hset(key, obj) {
    this._checkExpiry(key);
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const hash = this.hashes.get(key);
    let changed = 0;
    for (const [field, value] of Object.entries(obj || {})) {
      if (!hash.has(field) || hash.get(field) !== String(value)) changed += 1;
      hash.set(field, String(value));
    }
    return changed;
  }
  async hgetall(key) { this._checkExpiry(key); const hash = this.hashes.get(key); if (!hash) return {}; return Object.fromEntries(hash.entries()); }
  async expire(key, seconds) { this.expiry.set(key, Date.now() + Number(seconds) * 1000); return 1; }
  async eval() { throw new Error('EVAL_UNSUPPORTED_BY_MEMORY_ENGINE'); }
  async geoadd(key, lng, lat, member) {
    this._checkExpiry(key);
    if (!this.geo.has(key)) this.geo.set(key, new Map());
    this.geo.get(key).set(String(member), { lng: Number(lng), lat: Number(lat) });
    return 1;
  }
  async geosearch(key, fromWord, lng, lat, byRadiusWord, radiusKm, unitWord, withDistWord, withCoordsWord, sortOrderStr) {
    const entries = this.geo.get(key) || new Map();
    const originLng = Number(lng);
    const originLat = Number(lat);
    const radius = Number(radiusKm);
    const results = [];
    for (const [member, point] of entries.entries()) {
      const distanceKm = calcHaversine(originLat, originLng, point.lat, point.lng);
      if (distanceKm <= radius) {
        const row = [member];
        if (withDistWord) row.push(String(distanceKm));
        if (withCoordsWord) row.push([String(point.lng), String(point.lat)]);
        results.push({ row, distanceKm });
      }
    }
    results.sort((a, b) => a.distanceKm - b.distanceKm);
    return results.map(item => item.row);
  }
  async zrem(key, member) { const geo = this.geo.get(key); if (!geo) return 0; return geo.delete(String(member)) ? 1 : 0; }
  async rpush(key, value) { if (!this.lists.has(key)) this.lists.set(key, []); const list = this.lists.get(key); list.push(String(value)); return list.length; }
  async ltrim(key, start, stop) {
    const list = this.lists.get(key) || [];
    const normalizedStart = start < 0 ? Math.max(0, list.length + start) : start;
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    this.lists.set(key, list.slice(normalizedStart, normalizedStop + 1));
    return 'OK';
  }
  async lrange(key, start, stop) {
    const list = this.lists.get(key) || [];
    const normalizedStart = start < 0 ? Math.max(0, list.length + start) : start;
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    return list.slice(normalizedStart, normalizedStop + 1);
  }
  async publish(channel, message) {
    const handlers = this.subscriptions.get(channel) || [];
    for (const handler of handlers) handler(message);
    return handlers.length;
  }
  async subscribe(channel, handler) {
    if (!this.subscriptions.has(channel)) this.subscriptions.set(channel, new Set());
    this.subscriptions.get(channel).add(handler);
    return true;
  }
  async unsubscribe(channel, handler) {
    const handlers = this.subscriptions.get(channel);
    if (!handlers) return true;
    handlers.delete(handler);
    if (!handlers.size) this.subscriptions.delete(channel);
    return true;
  }
}

function calcHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (Number(lat2) - Number(lat1)) * Math.PI / 180;
  const dLon = (Number(lon2) - Number(lon1)) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(Number(lat1) * Math.PI / 180) * Math.cos(Number(lat2) * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const sharedMemoryRedisEngine = new RedisMemoryEngine();

class RedisClient {
  constructor(options = {}) {
    this.redis = null;
    this.engine = sharedMemoryRedisEngine;
    this.subscriber = null;
    this.subscriptionHandlers = new Map();
    this.isConnected = false;

    const redisUrl = options.url || process.env.REDIS_URL;
    const useExternal = Boolean(redisUrl) && (process.env.NODE_ENV === 'production' || process.env.ENABLE_DEV_REDIS === 'true' || options.forceExternal === true);
    if (useExternal) {
      try {
        const Redis = require('ioredis');
        this.redis = new Redis(redisUrl, {
          lazyConnect: false,
          maxRetriesPerRequest: 2,
          enableOfflineQueue: false
        });
        this.redis.on('ready', () => { this.isConnected = true; });
        this.redis.on('close', () => { this.isConnected = false; });
        this.redis.on('error', () => {});
      } catch (_) {
        this.redis = null;
      }
    }
  }

  async connect() {
    if (this.redis) {
      if (this.redis.status === 'wait') await this.redis.connect();
      this.isConnected = this.redis.status === 'ready';
      return this.isConnected;
    }
    this.isConnected = true;
    return true;
  }

  async ping() { return this.redis ? this.redis.ping() : 'PONG'; }
  async get(key) { return this.redis ? this.redis.get(key) : this.engine.get(key); }
  async set(key, value, ...args) { return this.redis ? this.redis.set(key, value, ...args) : this.engine.set(key, value, ...args); }
  async del(key) { return this.redis ? this.redis.del(key) : this.engine.del(key); }
  async exists(key) { return this.redis ? this.redis.exists(key) : this.engine.exists(key); }
  async sadd(key, member) { return this.redis ? this.redis.sadd(key, member) : this.engine.sadd(key, member); }
  async smembers(key) { return this.redis ? this.redis.smembers(key) : this.engine.smembers(key); }
  async srem(key, member) { return this.redis ? this.redis.srem(key, member) : this.engine.srem(key, member); }
  async hset(key, obj) { return this.redis ? this.redis.hset(key, obj) : this.engine.hset(key, obj); }
  async hgetall(key) { return this.redis ? this.redis.hgetall(key) : this.engine.hgetall(key); }
  async expire(key, seconds) { return this.redis ? this.redis.expire(key, seconds) : this.engine.expire(key, seconds); }
  async eval(script, numKeys, ...args) {
    if (this.redis) return this.redis.eval(script, numKeys, ...args);
    throw new Error('EVAL_UNSUPPORTED_BY_MEMORY_ENGINE');
  }
  async geoadd(key, lng, lat, member) { return this.redis ? this.redis.geoadd(key, lng, lat, member) : this.engine.geoadd(key, lng, lat, member); }
  async geosearch(key, fromWord, lng, lat, byRadiusWord, radiusKm, unitWord, withDistWord, withCoordsWord, sortOrderStr) {
    if (!this.redis) return this.engine.geosearch(key, fromWord, lng, lat, byRadiusWord, radiusKm, unitWord, withDistWord, withCoordsWord, sortOrderStr);

    // Use GEORADIUS for the production spatial adapter. It is supported by
    // the Redis versions used by VAAYU certification and avoids the divergent
    // GEOSEARCH argument grammar across Redis/ioredis versions. The caller's
    // stable adapter contract remains unchanged.
    const args = [
      'GEORADIUS',
      key,
      lng,
      lat,
      radiusKm,
      unitWord || 'km'
    ];
    if (withDistWord) args.push(withDistWord);
    if (withCoordsWord) args.push(withCoordsWord === 'WITHCOORDS' ? 'WITHCOORD' : withCoordsWord);
    if (sortOrderStr) args.push(sortOrderStr);

    return await this.redis.call(...args);
  }
  async zrem(key, member) { return this.redis ? this.redis.zrem(key, member) : this.engine.zrem(key, member); }
  async rpush(key, value) { return this.redis ? this.redis.rpush(key, value) : this.engine.rpush(key, value); }
  async ltrim(key, start, stop) { return this.redis ? this.redis.ltrim(key, start, stop) : this.engine.ltrim(key, start, stop); }
  async lrange(key, start, stop) { return this.redis ? this.redis.lrange(key, start, stop) : this.engine.lrange(key, start, stop); }
  async publish(channel, message) { return this.redis ? this.redis.publish(channel, typeof message === 'string' ? message : JSON.stringify(message)) : this.engine.publish(channel, message); }

  async subscribe(channel, handler) {
    if (this.redis) {
      if (!this.subscriber) {
        this.subscriber = this.redis.duplicate();
        this.subscriber.on('error', () => {});
        this.subscriber.on('message', (messageChannel, message) => {
          const handlers = this.subscriptionHandlers.get(messageChannel) || [];
          let parsed = message;
          try { parsed = JSON.parse(message); } catch (_) {}
          handlers.forEach(callback => callback(parsed));
        });
      }
      const handlers = this.subscriptionHandlers.get(channel) || [];
      handlers.push(handler);
      this.subscriptionHandlers.set(channel, handlers);
      if (handlers.length === 1) await this.subscriber.subscribe(channel);
      return true;
    }
    return this.engine.subscribe(channel, handler);
  }

  async unsubscribe(channel, handler) {
    if (this.redis) {
      const handlers = this.subscriptionHandlers.get(channel) || [];
      this.subscriptionHandlers.set(channel, handlers.filter(callback => callback !== handler));
      if (!this.subscriptionHandlers.get(channel).length && this.subscriber) {
        this.subscriptionHandlers.delete(channel);
        await this.subscriber.unsubscribe(channel);
      }
      return true;
    }
    return this.engine.unsubscribe(channel, handler);
  }

  async disconnect() {
    if (this.subscriber) {
      try { this.subscriber.disconnect(); } catch (_) {}
      this.subscriber = null;
    }
    if (this.redis) {
      try { this.redis.disconnect(); } catch (_) {}
    }
    this.isConnected = false;
  }
}

module.exports = {
  RedisClient,
  sharedMemoryRedisEngine
};