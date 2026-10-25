const { RedisClient } = require('./redisClient');
const db = require('../db/database');

/**
 * VAAYU Driver Location Store Abstraction
 *
 * Provides unified interface for:
 * 1. InMemoryDriverLocationStore (Default for single-process local dev)
 * 2. RedisDriverLocationStore (Production multi-instance shared spatial & telemetry state)
 */

class DriverLocationStore {
  async saveDriverLocation(driverId, record) { throw new Error('Not implemented'); }
  async getDriverLocation(driverId) { throw new Error('Not implemented'); }
  async findNearbyDrivers(lat, lng, radiusKm, vehicleId) { throw new Error('Not implemented'); }
  async appendHistory(driverId, point) { throw new Error('Not implemented'); }
  async getDriverHistory(driverId, tripId) { throw new Error('Not implemented'); }
  async setDriverAvailability(driverId, isOnline) { throw new Error('Not implemented'); }
  async clearDriverLocation(driverId) { throw new Error('Not implemented'); }
}

class InMemoryDriverLocationStore extends DriverLocationStore {
  constructor() {
    super();
    this.activeDrivers = new Map();
    this.locationHistory = new Map();
    this.MAX_HISTORY_PER_DRIVER = 500;
  }

  async clearDriverLocation(driverId) {
    this.activeDrivers.delete(driverId);
  }

  async saveDriverLocation(driverId, record) {
    this.activeDrivers.set(driverId, record);
    return record;
  }

  async getDriverLocation(driverId) {
    return this.activeDrivers.get(driverId) || null;
  }

  async findNearbyDrivers(lat, lng, radiusKm = 10, vehicleId = null) {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    const now = Date.now();

    if (isNaN(latNum) || isNaN(lngNum)) return [];

    const nearby = [];

    for (const [driverId, driver] of this.activeDrivers.entries()) {
      const pingAgeSec = (now - driver.lastPingMs) / 1000;

      let effectiveStatus = driver.status;
      if (pingAgeSec > 60) {
        effectiveStatus = 'OFFLINE';
      } else if (pingAgeSec > 30) {
        effectiveStatus = 'STALE';
      } else if (pingAgeSec > 15) {
        effectiveStatus = 'DEGRADED';
      }

      if ((effectiveStatus === 'ONLINE' || effectiveStatus === 'DEGRADED') && driver.status !== 'OFFLINE' && !driver.currentTripId) {
        if (!vehicleId || driver.vehicleId === vehicleId) {
          const distanceKm = calcHaversine(latNum, lngNum, driver.lat, driver.lng);
          if (distanceKm <= radiusKm) {
            nearby.push({
              driverId: driver.driverId,
              name: driver.name,
              vehicleId: driver.vehicleId,
              lat: driver.lat,
              lng: driver.lng,
              bearing: driver.bearing,
              speed: driver.speed,
              effectiveStatus,
              distanceKm: Math.round(distanceKm * 100) / 100,
              etaMinutes: Math.max(1, Math.round((distanceKm / 25) * 60))
            });
          }
        }
      }
    }

    return nearby.sort((a, b) => a.distanceKm - b.distanceKm);
  }

  async appendHistory(driverId, point) {
    if (!this.locationHistory.has(driverId)) {
      this.locationHistory.set(driverId, []);
    }
    const history = this.locationHistory.get(driverId);
    history.push(point);

    if (history.length > this.MAX_HISTORY_PER_DRIVER) {
      history.shift();
    }
  }

  async getDriverHistory(driverId, tripId = null) {
    const history = this.locationHistory.get(driverId) || [];
    if (tripId) return history.filter(p => p.tripId === tripId);
    return history;
  }

  async setDriverAvailability(driverId, isOnline) {
    let driver = this.activeDrivers.get(driverId);
    if (!driver) {
      const dbStore = db.getDb();
      const dProf = (dbStore.driver_profiles || []).find(d => d.id === driverId || d.userId === driverId);
      const latVal = Number(dProf?.currentLat ?? dProf?.lat ?? 17.4850);
      const lngVal = Number(dProf?.currentLng ?? dProf?.lng ?? 78.4041);
      driver = {
        driverId,
        lat: Number.isFinite(latVal) ? latVal : 17.4850,
        lng: Number.isFinite(lngVal) ? lngVal : 78.4041,
        bearing: 0,
        speed: 0,
        lastPingMs: Date.now(),
        status: isOnline ? 'ONLINE' : 'OFFLINE',
        vehicleId: dProf ? dProf.vehicleId : 'v_ace',
        updatedAt: new Date().toISOString()
      };
    } else {
      driver.status = isOnline ? 'ONLINE' : 'OFFLINE';
      driver.updatedAt = new Date().toISOString();
    }
    this.activeDrivers.set(driverId, driver);
    return { success: true, driver };
  }
}

class RedisDriverLocationStore extends DriverLocationStore {
  constructor(redisClient = null) {
    super();
    this.redis = redisClient || new RedisClient();
  }

  async disconnect() {
    if (this.redis && typeof this.redis.disconnect === 'function') await this.redis.disconnect();
  }

  async clearDriverLocation(driverId) {
    if (!this.redis) return;
    const key = `driver:loc:${driverId}`;
    await this.redis.zrem('drivers:active:spatial', driverId);
    await this.redis.del(key);
  }

  async saveDriverLocation(driverId, record) {
    if (!this.redis) return null;
    const key = `driver:loc:${driverId}`;
    await this.redis.hset(key, {
      ...record,
      updatedAt: record.updatedAt || new Date().toISOString()
    });
    await this.redis.expire(key, 120);
    await this.redis.geoadd('drivers:active:spatial', record.lng, record.lat, driverId);
    return record;
  }

  async getDriverLocation(driverId) {
    if (!this.redis) return null;
    const raw = await this.redis.hgetall(`driver:loc:${driverId}`);
    if (!raw || !raw.driverId) return null;
    return {
      ...raw,
      lat: parseFloat(raw.lat),
      lng: parseFloat(raw.lng),
      bearing: parseFloat(raw.bearing || 0),
      speed: parseFloat(raw.speed || 0),
      currentTripId: (raw.currentTripId && raw.currentTripId !== 'null' && raw.currentTripId !== 'undefined' && raw.currentTripId !== '') ? raw.currentTripId : null,
      lastPingMs: parseInt(raw.lastPingMs || 0, 10)
    };
  }

  async findNearbyDrivers(lat, lng, radiusKm = 10, vehicleId = null) {
    if (!this.redis) return [];
    const latNum = Number(lat);
    const lngNum = Number(lng);
    const radiusNum = Number(radiusKm);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum) || !Number.isFinite(radiusNum) || radiusNum < 0) return [];

    const rawResults = await this.redis.geosearch(
      'drivers:active:spatial',
      'FROMLONGLAT', lngNum, latNum,
      'BYRADIUS', radiusNum, 'km',
      'WITHDIST', 'WITHCOORD', 'ASC'
    );

    const now = Date.now();
    const results = [];
    for (const rawResult of rawResults || []) {
      // Redis/ioredis returns [member, distance, [lng, lat]]. The memory
      // adapter follows the same shape. Ignore malformed candidates rather
      // than letting one corrupt result invalidate the whole search.
      if (!Array.isArray(rawResult) || rawResult.length < 2) continue;
      const driverId = String(rawResult[0]);
      const redisDistanceKm = Number(rawResult[1]);
      if (!Number.isFinite(redisDistanceKm)) continue;

      const driverLoc = await this.getDriverLocation(driverId);
      if (!driverLoc) {
        // Remove orphaned spatial members so subsequent searches cannot keep
        // returning records whose authoritative location hash has expired.
        await this.redis.zrem('drivers:active:spatial', driverId);
        continue;
      }

      const pingAgeSec = (now - driverLoc.lastPingMs) / 1000;
      let liveness = 'ONLINE';
      if (pingAgeSec > 60) {
        await this.clearDriverLocation(driverId);
        continue;
      } else if (pingAgeSec > 30) {
        continue;
      } else if (pingAgeSec > 15) {
        liveness = 'DEGRADED';
      }

      if (driverLoc.status === 'OFFLINE' || driverLoc.currentTripId) continue;
      if (vehicleId && String(driverLoc.vehicleId) !== String(vehicleId)) continue;

      // Recalculate from the authoritative hash coordinates. Redis distance is
      // useful for candidate selection, but the returned driver object should
      // always expose the same distance semantics as the in-memory provider.
      const distanceKm = calcHaversine(latNum, lngNum, driverLoc.lat, driverLoc.lng);
      if (distanceKm > radiusNum) continue;

      results.push({
        ...driverLoc,
        effectiveStatus: liveness,
        distanceKm: Math.round(distanceKm * 100) / 100,
        etaMinutes: Math.max(1, Math.round((distanceKm / 25) * 60))
      });
    }

    // Redis promises ASC ordering, but filtering stale/offline/trip-bound
    // candidates can change the returned set. Always establish the contract
    // explicitly at the store boundary.
    return results.sort((a, b) => a.distanceKm - b.distanceKm);
  }

  async appendHistory(driverId, point) {
    if (!this.redis) return;
    const key = `driver:history:${driverId}`;
    await this.redis.rpush(key, JSON.stringify(point));
    await this.redis.ltrim(key, -500, -1);
  }

  async getDriverHistory(driverId, tripId = null) {
    if (!this.redis) return [];
    const key = `driver:history:${driverId}`;
    const rawList = await this.redis.lrange(key, 0, -1);
    const list = rawList.map(item => JSON.parse(item));
    if (tripId) return list.filter(p => p.tripId === tripId);
    return list;
  }

  async setDriverAvailability(driverId, isOnline) {
    if (!this.redis) return { success: false, error: 'Redis client not connected' };
    let loc = await this.getDriverLocation(driverId);
    if (!loc) {
      const dbStore = db.getDb();
      const dProf = (dbStore.driver_profiles || []).find(d => d.id === driverId || d.userId === driverId);
      const latVal = Number(dProf?.currentLat ?? dProf?.lat ?? 17.4850);
      const lngVal = Number(dProf?.currentLng ?? dProf?.lng ?? 78.4041);
      loc = {
        driverId,
        lat: Number.isFinite(latVal) ? latVal : 17.4850,
        lng: Number.isFinite(lngVal) ? lngVal : 78.4041,
        bearing: 0,
        speed: 0,
        lastPingMs: Date.now(),
        status: isOnline ? 'ONLINE' : 'OFFLINE',
        vehicleId: dProf ? dProf.vehicleId : 'v_ace',
        updatedAt: new Date().toISOString()
      };
    } else {
      loc.status = isOnline ? 'ONLINE' : 'OFFLINE';
      loc.updatedAt = new Date().toISOString();
    }
    await this.saveDriverLocation(driverId, loc);
    return { success: true, driver: loc };
  }
}

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

const inMemoryStore = new InMemoryDriverLocationStore();
const redisStore = new RedisDriverLocationStore();

function getActiveDriverLocationStore() {
  const provider = (process.env.REDIS_PROVIDER || 'redis').toLowerCase();
  if (provider === 'redis' || process.env.REDIS_URL || process.env.REDIS_HOST) return redisStore;
  return inMemoryStore;
}

module.exports = {
  DriverLocationStore,
  InMemoryDriverLocationStore,
  RedisDriverLocationStore,
  getActiveDriverLocationStore,
  inMemoryStore,
  redisStore,
  calcHaversine
};
