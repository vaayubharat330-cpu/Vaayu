const { RedisClient } = require('./redisClient');
const crypto = require('crypto');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

/**
 * VAAYU distributed lock manager.
 * Driver reservations remain the primary dispatch lock. Trip/idempotency locks are
 * short-lived command serialization primitives used to prevent duplicate concurrent
 * commands across backend instances.
 */
class RedisLockManager {
  constructor(redisClient = null) {
    this.redis = redisClient || new RedisClient();
    this.LOCK_PREFIX = 'dispatch:driver-lock:';
    this.TRIP_PREFIX = 'command:trip-lock:';
    this.IDEMPOTENCY_PREFIX = 'command:idempotency-lock:';
    this.DECLINED_PREFIX = 'dispatch:declined:';
    this.DEFAULT_TTL_MS = 30000;
    this.COMMAND_LOCK_TTL_MS = 15000;
  }

  async disconnect() {
    if (this.redis && typeof this.redis.disconnect === 'function') await this.redis.disconnect();
  }

  async acquireDriverLock(driverId, orderId, ttlMs = this.DEFAULT_TTL_MS) {
    if (!driverId || !orderId) return { success: false, error: 'driverId and orderId are required' };
    const key = `${this.LOCK_PREFIX}${driverId}`;
    const reservationId = `res_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const lockPayload = JSON.stringify({ orderId, driverId, reservationId, acquiredAt: now, expiresAt, ttlMs });
    const lockStart = Date.now();
    const result = await this.redis.set(key, lockPayload, 'NX', 'PX', ttlMs);
    const lockDuration = Date.now() - lockStart;
    metricsService.recordLatency('redis_lock_latency', lockDuration);
    metricsService.recordLatency('redis_operation_latency', lockDuration);
    if (result === 'OK' || result === true) {
      metricsService.increment('redis_lock_acquire_success_total');
      logger.info('driver_lock_acquired', `Driver lock acquired for ${driverId}`, { driverId, orderId, reservationId, service: 'dispatch' });
      return { success: true, driverId, orderId, reservationId, expiresAt, ttlMs };
    }
    metricsService.increment('redis_lock_acquire_failure_total');
    metricsService.increment('dispatch_driver_lock_collision_total');
    const existingRaw = await this.redis.get(key);
    let currentOwner = null;
    if (existingRaw) { try { currentOwner = JSON.parse(existingRaw); } catch (_) {} }
    return { success: false, code: 'DRIVER_LOCKED', driverId, orderId, currentOwner,
      message: `Driver ${driverId} is currently reserved by order ${currentOwner ? currentOwner.orderId : 'another_order'}` };
  }

  async releaseDriverLock(driverId, ownerIdOrReservationId) {
    if (!driverId || !ownerIdOrReservationId) return false;
    const key = `${this.LOCK_PREFIX}${driverId}`;
    const expected = ownerIdOrReservationId;
    const result = await this._releaseOwnedKey(key, (raw) => {
      try {
        const payload = JSON.parse(raw);
        return payload.reservationId === expected || payload.orderId === expected;
      } catch (_) {
        return false;
      }
    });
    if (result) {
      metricsService.increment('redis_lock_release_total');
      logger.info('driver_lock_released', `Driver lock released for ${driverId}`, { driverId, ownerIdOrReservationId, service: 'dispatch' });
    }
    return result;
  }

  async getDriverLock(driverId) {
    if (!driverId) return null;
    const key = `${this.LOCK_PREFIX}${driverId}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      const payload = JSON.parse(raw);
      if (Date.now() > payload.expiresAt) {
        await this._releaseOwnedKey(key, current => current === raw);
        return null;
      }
      return payload;
    } catch (_) { return null; }
  }

  async refreshDriverLock(driverId, reservationId, additionalTtlMs = 30000) {
    if (!driverId || !reservationId) return { success: false, error: 'driverId and reservationId are required' };
    const key = `${this.LOCK_PREFIX}${driverId}`;
    const currentRaw = await this.redis.get(key);
    if (!currentRaw) return { success: false, error: 'Lock not found or owned by another reservation' };

    let lock;
    try { lock = JSON.parse(currentRaw); } catch (_) {
      return { success: false, error: 'Lock payload is invalid' };
    }
    if (lock.reservationId !== reservationId) {
      return { success: false, error: 'Lock not found or owned by another reservation' };
    }

    const refreshed = { ...lock, expiresAt: Date.now() + additionalTtlMs };
    const nextRaw = JSON.stringify(refreshed);
    const updated = await this._compareAndSet(key, currentRaw, nextRaw, additionalTtlMs);
    if (!updated) return { success: false, error: 'Lock ownership changed before refresh' };
    return { success: true, lock: refreshed };
  }

  /**
   * Release only if the current Redis value is still owned by this caller.
   * Production Redis uses atomic Lua compare-and-delete. The in-memory test engine
   * falls back to GET/DEL because it intentionally has no EVAL primitive.
   */
  async _releaseOwnedKey(key, ownsValue) {
    const redisConnection = this.redis && this.redis.redis;
    if (redisConnection && typeof redisConnection.eval === 'function') {
      const expectedToken = await this.redis.get(key);
      if (!expectedToken) return true;
      if (!ownsValue(expectedToken)) return false;
      const deleted = await redisConnection.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        expectedToken
      );
      return Number(deleted) === 1;
    }

    const current = await this.redis.get(key);
    if (!current || !ownsValue(current)) return Boolean(!current);
    await this.redis.del(key);
    return true;
  }

  async _compareAndSet(key, expectedValue, nextValue, ttlMs) {
    const redisConnection = this.redis && this.redis.redis;
    if (redisConnection && typeof redisConnection.eval === 'function') {
      const result = await redisConnection.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1 else return 0 end",
        1,
        key,
        expectedValue,
        nextValue,
        String(ttlMs)
      );
      return Number(result) === 1;
    }

    const current = await this.redis.get(key);
    if (current !== expectedValue) return false;
    await this.redis.set(key, nextValue, 'PX', ttlMs);
    return true;
  }

  async acquireScopedLock(prefix, scopeId, ttlMs = this.COMMAND_LOCK_TTL_MS) {
    if (!scopeId) throw new Error('scopeId is required');
    const key = `${prefix}${scopeId}`;
    const token = `lock_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const result = await this.redis.set(key, token, 'NX', 'PX', ttlMs);
    if (result === 'OK' || result === true) return { success: true, key, token, expiresAt: Date.now() + ttlMs, ttlMs };
    return { success: false, key };
  }

  /** Refresh a scoped command lock while preserving the current ownership token. */
  async refreshScopedLock(lock, additionalTtlMs = this.COMMAND_LOCK_TTL_MS) {
    if (!lock || !lock.key || !lock.token) return { success: false, error: 'Invalid lock handle' };
    const updated = await this._compareAndSet(lock.key, lock.token, lock.token, additionalTtlMs);
    if (!updated) return { success: false, error: 'Lock ownership changed or expired' };
    return { success: true, key: lock.key, token: lock.token, expiresAt: Date.now() + additionalTtlMs, ttlMs: additionalTtlMs };
  }

  async releaseScopedLock(lock) {
    if (!lock || !lock.key || !lock.token) return false;
    return this._releaseOwnedKey(lock.key, current => current === lock.token);
  }

  async acquireTripLock(tripId, ttlMs = this.COMMAND_LOCK_TTL_MS) {
    return this.acquireScopedLock(this.TRIP_PREFIX, tripId, ttlMs);
  }

  async releaseTripLock(lock) {
    return this.releaseScopedLock(lock);
  }

  async acquireIdempotencyLock(idempotencyKey, ttlMs = this.COMMAND_LOCK_TTL_MS) {
    return this.acquireScopedLock(this.IDEMPOTENCY_PREFIX, idempotencyKey, ttlMs);
  }

  async refreshIdempotencyLock(lock, additionalTtlMs = this.COMMAND_LOCK_TTL_MS) {
    return this.refreshScopedLock(lock, additionalTtlMs);
  }

  async releaseIdempotencyLock(lock) {
    return this.releaseScopedLock(lock);
  }

  async addDeclinedDriver(orderId, driverId) {
    if (!orderId || !driverId) return;
    const key = `${this.DECLINED_PREFIX}${orderId}`;
    await this.redis.sadd(key, driverId);
    await this.redis.expire(key, 3600);
  }

  async getDeclinedDrivers(orderId) {
    if (!orderId) return new Set();
    const key = `${this.DECLINED_PREFIX}${orderId}`;
    return new Set((await this.redis.smembers(key)) || []);
  }
}

const redisLockManager = new RedisLockManager();

module.exports = { RedisLockManager, redisLockManager };
