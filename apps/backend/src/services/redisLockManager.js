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
    const existingRaw = await this.redis.get(key);
    if (!existingRaw) return true;
    try {
      const payload = JSON.parse(existingRaw);
      if (payload.reservationId === ownerIdOrReservationId || payload.orderId === ownerIdOrReservationId) {
        await this.redis.del(key);
        metricsService.increment('redis_lock_release_total');
        logger.info('driver_lock_released', `Driver lock released for ${driverId}`, { driverId, reservationId: payload.reservationId, service: 'dispatch' });
        return true;
      }
    } catch (_) {}
    return false;
  }

  async getDriverLock(driverId) {
    if (!driverId) return null;
    const key = `${this.LOCK_PREFIX}${driverId}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      const payload = JSON.parse(raw);
      if (Date.now() > payload.expiresAt) { await this.redis.del(key); return null; }
      return payload;
    } catch (_) { return null; }
  }

  async refreshDriverLock(driverId, reservationId, additionalTtlMs = 30000) {
    const lock = await this.getDriverLock(driverId);
    if (!lock || lock.reservationId !== reservationId) return { success: false, error: 'Lock not found or owned by another reservation' };
    const key = `${this.LOCK_PREFIX}${driverId}`;
    lock.expiresAt = Date.now() + additionalTtlMs;
    await this.redis.set(key, JSON.stringify(lock), 'PX', additionalTtlMs);
    return { success: true, lock };
  }

  async acquireScopedLock(prefix, scopeId, ttlMs = this.COMMAND_LOCK_TTL_MS) {
    if (!scopeId) throw new Error('scopeId is required');
    const key = `${prefix}${scopeId}`;
    const token = `lock_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const result = await this.redis.set(key, token, 'NX', 'PX', ttlMs);
    if (result === 'OK' || result === true) return { success: true, key, token, expiresAt: Date.now() + ttlMs };
    return { success: false, key };
  }

  async releaseScopedLock(lock) {
    if (!lock || !lock.key || !lock.token) return false;
    const current = await this.redis.get(lock.key);
    if (current !== lock.token) return false;
    await this.redis.del(lock.key);
    return true;
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
