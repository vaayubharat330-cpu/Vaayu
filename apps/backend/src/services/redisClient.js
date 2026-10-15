const net = require('net');
const Redis = require('ioredis');

function calcHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

/**
 * VAAYU Milestone 6 Phase 6.2/6.3: Redis Client & Shared Operational Engine
 * 
 * Provides:
 * 1. Redis RESP TCP Client Adapter (connects to Redis Server 6379 via TCP socket).
 * 2. Shared Memory Redis Engine (Simulates shared multi-node Redis cluster for local testing & multi-instance Node A/B/C verification).
 */

class RedisMemoryEngine {
  constructor() {
    this.hashes = new Map();
    this.geoSpatialSets = new Map();
    this.lists = new Map();
    this.stringKeys = new Map();
    this.setKeys = new Map();
    this.ttls = new Map();
  }

  // 1. String / Lock Operations (SET / GET / DEL)
  async set(key, value, ...args) {
    if (this.ttls.has(key) && Date.now() > this.ttls.get(key)) {
      this.stringKeys.delete(key);
      this.ttls.delete(key);
    }

    let isNx = false;
    let ttlMs = null;

    for (let i = 0; i < args.length; i++) {
      const arg = String(args[i]).toUpperCase();
      if (arg === 'NX') isNx = true;
      if (arg === 'PX' && args[i + 1] != null) ttlMs = parseInt(args[i + 1], 10);
      if (arg === 'EX' && args[i + 1] != null) ttlMs = parseInt(args[i + 1], 10) * 1000;
    }

    if (isNx && this.stringKeys.has(key)) return null;

    this.stringKeys.set(key, String(value));
    if (ttlMs) this.ttls.set(key, Date.now() + ttlMs);
    return 'OK';
  }

  async get(key) {
    if (this.ttls.has(key) && Date.now() > this.ttls.get(key)) {
      this.stringKeys.delete(key);
      this.ttls.delete(key);
      return null;
    }
    return this.stringKeys.get(key) || null;
  }

  async incr(key) {
    if (this.ttls.has(key) && Date.now() > this.ttls.get(key)) {
      this.stringKeys.delete(key);
      this.ttls.delete(key);
    }
    const currentVal = parseInt(this.stringKeys.get(key) || '0', 10);
    const newVal = currentVal + 1;
    this.stringKeys.set(key, String(newVal));
    return newVal;
  }

  async del(key) {
    this.stringKeys.delete(key);
    this.hashes.delete(key);
    this.geoSpatialSets.delete(key);
    this.lists.delete(key);
    this.setKeys.delete(key);
    this.ttls.delete(key);
    return 1;
  }

  // 2. Set Operations (SADD / SMEMBERS)
  async sadd(key, member) {
    if (!this.setKeys.has(key)) this.setKeys.set(key, new Set());
    this.setKeys.get(key).add(String(member));
    return 1;
  }

  async smembers(key) {
    if (this.ttls.has(key) && Date.now() > this.ttls.get(key)) {
      this.setKeys.delete(key);
      this.ttls.delete(key);
      return [];
    }
    const set = this.setKeys.get(key);
    return set ? Array.from(set) : [];
  }

  // 3. Hash Operations (HSET / HGETALL)
  async hset(key, obj) {
    if (!this.hashes.has(key)) this.hashes.set(key, {});
    const hash = this.hashes.get(key);
    for (const [k, v] of Object.entries(obj)) hash[k] = String(v);
    return Object.keys(obj).length;
  }

  async hgetall(key) {
    if (this.ttls.has(key) && Date.now() > this.ttls.get(key)) {
      this.hashes.delete(key);
      this.ttls.delete(key);
      return {};
    }
    return this.hashes.get(key) || {};
  }

  async expire(key, seconds) {
    if (seconds <= 0) {
      await this.del(key);
      return 1;
    }
    this.ttls.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  // 4. Spatial Operations (GEOADD / GEOSEARCH / ZREM)
  async geoadd(key, lng, lat, member) {
    if (!this.geoSpatialSets.has(key)) this.geoSpatialSets.set(key, new Map());
    const set = this.geoSpatialSets.get(key);
    set.set(member, { lng: parseFloat(lng), lat: parseFloat(lat) });
    return 1;
  }

  async zrem(key, member) {
    if (this.geoSpatialSets.has(key)) this.geoSpatialSets.get(key).delete(member);
  }

  async geosearch(key, fromWord, lng, lat, byRadiusWord, radiusKm, unitWord, withDistWord, withCoordsWord, sortOrderStr) {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    const radiusNum = parseFloat(radiusKm);
    const set = this.geoSpatialSets.get(key);
    if (!set) return [];

    const results = [];
    for (const [member, coords] of set.entries()) {
      const dist = calcHaversine(latNum, lngNum, coords.lat, coords.lng);
      if (dist <= radiusNum) results.push([member, dist.toFixed(2), [coords.lng, coords.lat]]);
    }

    if (sortOrderStr === 'ASC') results.sort((a, b) => parseFloat(a[1]) - parseFloat(b[1]));
    else if (sortOrderStr === 'DESC') results.sort((a, b) => parseFloat(b[1]) - parseFloat(a[1]));
    return results;
  }

  // 5. List Operations (RPUSH / LTRIM / LRANGE)
  async rpush(key, value) {
    if (!this.lists.has(key)) this.lists.set(key, []);
    this.lists.get(key).push(value);
    return this.lists.get(key).length;
  }

  async ltrim(key, start, stop) {
    if (!this.lists.has(key)) return 'OK';
    const list = this.lists.get(key);
    const len = list.length;
    const s = start < 0 ? Math.max(0, len + start) : start;
    const e = stop < 0 ? Math.max(0, len + stop) : stop;
    this.lists.set(key, list.slice(s, e + 1));
    return 'OK';
  }

  async lrange(key, start, stop) {
    const list = this.lists.get(key) || [];
    const len = list.length;
    const s = start < 0 ? Math.max(0, len + start) : start;
    const e = stop < 0 ? Math.max(0, len + stop) : stop;
    return list.slice(s, stop === -1 ? undefined : e + 1);
  }

  // 6. Pub/Sub Operations (PUBLISH / SUBSCRIBE / UNSUBSCRIBE)
  async publish(channel, message) {
    if (!this.channels) this.channels = new Map();
    const handlers = this.channels.get(channel);
    if (!handlers || handlers.size === 0) return 0;
    const msgStr = typeof message === 'string' ? message : JSON.stringify(message);
    let count = 0;
    for (const handler of Array.from(handlers)) {
      try {
        handler(channel, msgStr);
        count++;
      } catch (err) {
        console.error('[RedisMemoryEngine] PubSub handler error:', err);
      }
    }
    return count;
  }

  async subscribe(channel, handler) {
    if (!this.channels) this.channels = new Map();
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel).add(handler);
    return true;
  }

  async unsubscribe(channel, handler) {
    if (!this.channels || !this.channels.has(channel)) return true;
    if (handler) this.channels.get(channel).delete(handler);
    else this.channels.delete(channel);
    return true;
  }
}

// Global Shared Engine Instance for Multi-Node Simulation
const sharedMemoryRedisEngine = new RedisMemoryEngine();

class RedisClient {
  constructor(config = {}) {
    this.host = config.host || process.env.REDIS_HOST || 'localhost';
    this.port = parseInt(config.port || process.env.REDIS_PORT || '6379', 10);
    this.engine = sharedMemoryRedisEngine;
    this.isConnected = false;
    this.redis = null;
    this.subscriber = null;
    this.subscriptionHandlers = new Map();
    const redisUrl = config.url || process.env.REDIS_URL;
    const useExternalRedis = Boolean(redisUrl) && (process.env.NODE_ENV === 'production' || process.env.ENABLE_DEV_REDIS === 'true');
    if (useExternalRedis) {
      this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2, enableReadyCheck: true });
      this.redis.on('ready', () => { this.isConnected = true; });
      this.redis.on('end', () => { this.isConnected = false; });
      this.redis.on('error', () => { this.isConnected = false; });
      if (this.redis.on) this.redis.on('error', () => {});
    } else if (process.env.NODE_ENV === 'production') {
      throw new Error('REDIS_URL is required in production; in-memory Redis is development-only');
    }
  }

  async connect() {
    if (this.redis) {
      try { await this.redis.ping(); this.isConnected = true; return true; }
      catch (_) { this.isConnected = false; return false; }
    }
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: this.host, port: this.port, timeout: 500 }, () => {
        socket.destroy();
        this.isConnected = true;
        resolve(true);
      });
      socket.on('error', () => { socket.destroy(); this.isConnected = false; resolve(false); });
      socket.on('timeout', () => { socket.destroy(); this.isConnected = false; resolve(false); });
    });
  }

  async set(key, value, ...args) { return this.redis ? this.redis.set(key, value, ...args) : this.engine.set(key, value, ...args); }
  async get(key) { return this.redis ? this.redis.get(key) : this.engine.get(key); }
  async incr(key) { return this.redis ? this.redis.incr(key) : this.engine.incr(key); }
  async del(key) { return this.redis ? this.redis.del(key) : this.engine.del(key); }
  async sadd(key, member) { return this.redis ? this.redis.sadd(key, member) : this.engine.sadd(key, member); }
  async smembers(key) { return this.redis ? this.redis.smembers(key) : this.engine.smembers(key); }
  async hset(key, obj) { return this.redis ? this.redis.hset(key, obj) : this.engine.hset(key, obj); }
  async hgetall(key) { return this.redis ? this.redis.hgetall(key) : this.engine.hgetall(key); }
  async expire(key, seconds) { return this.redis ? this.redis.expire(key, seconds) : this.engine.expire(key, seconds); }
  async eval(script, numKeys, ...args) {
    if (this.redis) return this.redis.eval(script, numKeys, ...args);
    throw new Error('EVAL_UNSUPPORTED_BY_MEMORY_ENGINE');
  }
  async geoadd(key, lng, lat, member) { return this.redis ? this.redis.geoadd(key, lng, lat, member) : this.engine.geoadd(key, lng, lat, member); }
  async geosearch(key, fromWord, lng, lat, byRadiusWord, radiusKm, unitWord, withDistWord, withCoordsWord, sortOrderStr) {
    if (this.redis) {
      try {
        return await this.redis.geosearch(key, fromWord, lng, lat, byRadiusWord, radiusKm, unitWord, withDistWord, withCoordsWord, sortOrderStr);
      } catch (err) {
        if (err.message && err.message.includes('unknown command')) {
          const args = [key, lng, lat, radiusKm, unitWord || 'km'];
          if (withDistWord) args.push(withDistWord);
          if (withCoordsWord) args.push(withCoordsWord.replace('WITHCOORDS', 'WITHCOORD'));
          if (sortOrderStr) args.push(sortOrderStr);
          return await this.redis.georadius(...args);
        }
        throw err;
      }
    }
    return this.engine.geosearch(key, fromWord, lng, lat, byRadiusWord, radiusKm, unitWord, withDistWord, withCoordsWord, sortOrderStr);
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