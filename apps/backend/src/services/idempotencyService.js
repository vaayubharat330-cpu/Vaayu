const db = require('../db/database');
const { redisLockManager } = require('./redisLockManager');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

/**
 * Multi-instance idempotency/replay protection.
 *
 * Durable PostgreSQL-backed responses remain the long-term replay source of truth. Redis
 * additionally stores a shared short-term replay record so a second backend instance does
 * not depend on its process-local PostgreSQL snapshot being fresh before replaying a command.
 * The Redis key lock closes the lookup -> business-side-effect race.
 */
class IdempotencyService {
  constructor() {
    this.memoryCache = new Map();
    this.pendingLocks = new Map();
    this.MAX_MEMORY_CACHE_ENTRIES = 1000;
    this.LOCK_WAIT_MS = 5000;
    this.LOCK_POLL_MS = 100;
    this.REDIS_RESPONSE_PREFIX = 'command:idempotency-response:';
    this.REDIS_RESPONSE_TTL_SEC = 86400;
    this.COMMAND_LOCK_TTL_MS = 15000;
    this.LOCK_REFRESH_INTERVAL_MS = 5000;
  }

  _redisResponseKey(idempotencyKey) {
    return `${this.REDIS_RESPONSE_PREFIX}${idempotencyKey}`;
  }

  async _readSharedResponse(idempotencyKey) {
    try {
      const raw = await redisLockManager.redis.get(this._redisResponseKey(idempotencyKey));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async _writeSharedResponse(idempotencyKey, response) {
    try {
      await redisLockManager.redis.set(
        this._redisResponseKey(idempotencyKey),
        JSON.stringify(response),
        'EX',
        this.REDIS_RESPONSE_TTL_SEC
      );
    } catch (err) {
      logger.warn('idempotency_shared_cache_write_failed', err.message, { idempotencyKey });
    }
  }

  async _readDurable(idempotencyKey) {
    const dbStore = db.getDb();
    const records = dbStore.idempotency_records || [];
    return records.find(r => r.idempotencyKey === idempotencyKey) || null;
  }

  _trackPendingLock(idempotencyKey, lock) {
    const existing = this.pendingLocks.get(idempotencyKey);
    if (existing && existing.timer) clearInterval(existing.timer);

    const entry = { lock, timer: null };
    entry.timer = setInterval(async () => {
      try {
        const refreshed = await redisLockManager.refreshIdempotencyLock(lock, this.COMMAND_LOCK_TTL_MS);
        if (!refreshed.success) {
          clearInterval(entry.timer);
          entry.timer = null;
          metricsService.increment('idempotency_lock_refresh_failed_total');
          logger.warn('idempotency_lock_refresh_failed', refreshed.error || 'lock ownership changed', { idempotencyKey });
        } else {
          metricsService.increment('idempotency_lock_refresh_total');
        }
      } catch (err) {
        metricsService.increment('idempotency_lock_refresh_failed_total');
        logger.warn('idempotency_lock_refresh_error', err.message, { idempotencyKey });
      }
    }, this.LOCK_REFRESH_INTERVAL_MS);
    entry.timer.unref?.();
    this.pendingLocks.set(idempotencyKey, entry);
  }

  _takePendingLock(idempotencyKey) {
    const entry = this.pendingLocks.get(idempotencyKey);
    if (!entry) return null;
    if (entry.timer) clearInterval(entry.timer);
    this.pendingLocks.delete(idempotencyKey);
    return entry.lock;
  }

  async findExistingResponse(idempotencyKey) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') return { found: false };

    if (this.memoryCache.has(idempotencyKey)) {
      const cached = this.memoryCache.get(idempotencyKey);
      metricsService.increment('idempotency_replay_total');
      return { found: true, statusCode: cached.statusCode, body: cached.body, fromCache: 'MEMORY' };
    }

    const shared = await this._readSharedResponse(idempotencyKey);
    if (shared) {
      this.cacheInMemory(idempotencyKey, shared.statusCode, shared.body);
      metricsService.increment('idempotency_replay_total');
      return { found: true, statusCode: shared.statusCode, body: shared.body, fromCache: 'REDIS_SHARED' };
    }

    try {
      const match = await this._readDurable(idempotencyKey);
      if (match) {
        this.cacheInMemory(idempotencyKey, match.statusCode, match.body);
        await this._writeSharedResponse(idempotencyKey, match);
        metricsService.increment('idempotency_replay_total');
        logger.info('idempotency_replay_served', `Idempotent response replayed for key ${idempotencyKey}`, { idempotencyKey });
        return { found: true, statusCode: match.statusCode, body: match.body, fromCache: 'DURABLE_STORE' };
      }
    } catch (err) {
      logger.warn('idempotency_durable_lookup_failed', err.message, { idempotencyKey });
    }

    const lock = await redisLockManager.acquireIdempotencyLock(idempotencyKey, this.COMMAND_LOCK_TTL_MS);
    if (lock.success) {
      this._trackPendingLock(idempotencyKey, lock);
      return { found: false };
    }

    const deadline = Date.now() + this.LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, this.LOCK_POLL_MS));

      const sharedRetry = await this._readSharedResponse(idempotencyKey);
      if (sharedRetry) {
        this.cacheInMemory(idempotencyKey, sharedRetry.statusCode, sharedRetry.body);
        metricsService.increment('idempotency_replay_total');
        return { found: true, statusCode: sharedRetry.statusCode, body: sharedRetry.body, fromCache: 'CONCURRENT_REPLAY' };
      }

      try {
        const match = await this._readDurable(idempotencyKey);
        if (match) {
          this.cacheInMemory(idempotencyKey, match.statusCode, match.body);
          await this._writeSharedResponse(idempotencyKey, match);
          metricsService.increment('idempotency_replay_total');
          return { found: true, statusCode: match.statusCode, body: match.body, fromCache: 'CONCURRENT_DURABLE_REPLAY' };
        }
      } catch (_) {}

      const retryLock = await redisLockManager.acquireIdempotencyLock(idempotencyKey, this.COMMAND_LOCK_TTL_MS);
      if (retryLock.success) {
        this._trackPendingLock(idempotencyKey, retryLock);
        return { found: false };
      }
    }

    metricsService.increment('idempotency_in_progress_total');
    return {
      found: true,
      statusCode: 409,
      body: { success: false, error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'An identical request is already being processed. Retry with the same idempotency key.' } },
      fromCache: 'CONCURRENT_LOCK'
    };
  }

  /**
   * Abort an in-flight idempotent command before a durable response exists.
   * Route handlers must call this when validation/business work exits without
   * saveResponse(); otherwise the distributed lease remains occupied until TTL expiry.
   */
  async abortResponse(idempotencyKey) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') return false;
    const lock = this._takePendingLock(idempotencyKey);
    if (!lock) return false;
    try {
      return await redisLockManager.releaseIdempotencyLock(lock);
    } catch (err) {
      logger.warn('idempotency_lock_release_failed', err.message, { idempotencyKey });
      return false;
    }
  }

  async saveResponse(idempotencyKey, orderId, statusCode, body) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') return;

    // A physical command may already have committed while a dependent side effect
    // (settlement/refund/provider work) is still pending. Persisting that response as
    // the final idempotent replay would prevent the same command from retrying the
    // unresolved financial side effect. The authoritative business state remains
    // committed; only the replay record is deliberately withheld.
    const dependentPaymentPending = Boolean(
      body && (
        (body.paymentSettlement && body.paymentSettlement.success === false) ||
        (body.paymentRefund && body.paymentRefund.success === false)
      )
    );
    if (dependentPaymentPending) {
      metricsService.increment('idempotency_response_deferred_total');
      logger.warn('idempotency_response_deferred_for_pending_payment', 'Command response was not cached because a dependent payment operation failed; retry remains allowed.', { idempotencyKey, orderId });
      await this.abortResponse(idempotencyKey);
      return;
    }

    let persisted = false;
    try {
      const dbStore = db.getDb();
      if (!dbStore.idempotency_records) dbStore.idempotency_records = [];
      const existingIdx = dbStore.idempotency_records.findIndex(r => r.idempotencyKey === idempotencyKey);
      const record = { idempotencyKey, orderId: orderId || null, statusCode, body, createdAt: new Date().toISOString() };
      if (existingIdx !== -1) dbStore.idempotency_records[existingIdx] = record;
      else dbStore.idempotency_records.push(record);
      db.saveDb(dbStore);
      await db.waitForCommit();
      persisted = true;
      this.cacheInMemory(idempotencyKey, statusCode, body);
      await this._writeSharedResponse(idempotencyKey, record);
    } catch (err) {
      logger.error('idempotency_durable_save_failed', err.message, { idempotencyKey });
      throw err;
    } finally {
      const lock = this._takePendingLock(idempotencyKey);
      if (lock) {
        try { await redisLockManager.releaseIdempotencyLock(lock); } catch (_) {}
      }
    }

    if (!persisted) throw new Error('Idempotency response was not durably persisted.');
  }

  cacheInMemory(key, statusCode, body) {
    this.memoryCache.set(key, { statusCode, body, timestamp: Date.now() });
    if (this.memoryCache.size > this.MAX_MEMORY_CACHE_ENTRIES) {
      const oldestKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(oldestKey);
    }
  }

  reset() {
    for (const entry of this.pendingLocks.values()) {
      if (entry.timer) clearInterval(entry.timer);
    }
    this.memoryCache.clear();
    this.pendingLocks.clear();
    try {
      const dbStore = db.getDb();
      dbStore.idempotency_records = [];
      db.saveDb(dbStore);
    } catch (_) {}
  }
}

const idempotencyService = new IdempotencyService();

module.exports = { IdempotencyService, idempotencyService };
