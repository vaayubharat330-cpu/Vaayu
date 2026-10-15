const db = require('../db/database');
const { redisLockManager } = require('./redisLockManager');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

/**
 * Multi-instance idempotency/replay protection.
 *
 * The durable response remains the replay source of truth. A Redis key lock closes
 * the concurrent-request race between the initial lookup and the business side-effect.
 * The lock has a bounded TTL so a crashed worker cannot permanently block a key.
 * A truly crash-proof exactly-once command requires the business mutation and the
 * idempotency record to share one database transaction; this service therefore does
 * not claim stronger semantics than the surrounding persistence boundary provides.
 */
class IdempotencyService {
  constructor() {
    this.memoryCache = new Map();
    this.pendingLocks = new Map();
    this.MAX_MEMORY_CACHE_ENTRIES = 1000;
    this.LOCK_WAIT_MS = 5000;
    this.LOCK_POLL_MS = 100;
  }

  async _readDurable(idempotencyKey) {
    const dbStore = db.getDb();
    const records = dbStore.idempotency_records || [];
    return records.find(r => r.idempotencyKey === idempotencyKey) || null;
  }

  async findExistingResponse(idempotencyKey) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') return { found: false };

    if (this.memoryCache.has(idempotencyKey)) {
      const cached = this.memoryCache.get(idempotencyKey);
      metricsService.increment('idempotency_replay_total');
      return { found: true, statusCode: cached.statusCode, body: cached.body, fromCache: 'MEMORY' };
    }

    try {
      const match = await this._readDurable(idempotencyKey);
      if (match) {
        this.cacheInMemory(idempotencyKey, match.statusCode, match.body);
        metricsService.increment('idempotency_replay_total');
        logger.info('idempotency_replay_served', `Idempotent response replayed for key ${idempotencyKey}`, { idempotencyKey });
        return { found: true, statusCode: match.statusCode, body: match.body, fromCache: 'DURABLE_STORE' };
      }
    } catch (err) {
      logger.warn('idempotency_durable_lookup_failed', err.message, { idempotencyKey });
    }

    // Only one backend instance may cross the lookup -> business mutation boundary.
    const lock = await redisLockManager.acquireIdempotencyLock(idempotencyKey);
    if (lock.success) {
      this.pendingLocks.set(idempotencyKey, lock);
      return { found: false };
    }

    // Another instance owns the key. Give it a short window to finish and persist the
    // response; never execute the same business command concurrently.
    const deadline = Date.now() + this.LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, this.LOCK_POLL_MS));
      try {
        const match = await this._readDurable(idempotencyKey);
        if (match) {
          this.cacheInMemory(idempotencyKey, match.statusCode, match.body);
          metricsService.increment('idempotency_replay_total');
          return { found: true, statusCode: match.statusCode, body: match.body, fromCache: 'CONCURRENT_REPLAY' };
        }
      } catch (_) {}
      const retryLock = await redisLockManager.acquireIdempotencyLock(idempotencyKey);
      if (retryLock.success) {
        this.pendingLocks.set(idempotencyKey, retryLock);
        return { found: false };
      }
    }

    metricsService.increment('idempotency_in_progress_total');
    return {
      found: true,
      statusCode: 409,
      body: {
        success: false,
        error: {
          code: 'IDEMPOTENCY_IN_PROGRESS',
          message: 'An identical request is already being processed. Retry with the same idempotency key.'
        }
      },
      fromCache: 'CONCURRENT_LOCK'
    };
  }

  async saveResponse(idempotencyKey, orderId, statusCode, body) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') return;

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
    } catch (err) {
      logger.error('idempotency_durable_save_failed', err.message, { idempotencyKey });
      throw err;
    } finally {
      const lock = this.pendingLocks.get(idempotencyKey);
      if (lock) {
        try { await redisLockManager.releaseIdempotencyLock(lock); } catch (_) {}
        this.pendingLocks.delete(idempotencyKey);
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
