'use strict';

const { PostgresPool } = require('../../db/postgresClient');
const { metricsService } = require('../metricsService');
const { logger } = require('../logger');

/**
 * VAAYU TRANSACTIONAL OUTBOX DISPATCHER WORKER
 *
 * Hardening model:
 * 1. Rows are claimed in a short PostgreSQL transaction with FOR UPDATE SKIP LOCKED.
 * 2. Claimed rows move to PROCESSING with a unique per-row lease token before any
 *    downstream WebSocket/custom handler is awaited. The database transaction is
 *    never held open across network/application work.
 * 3. A crashed worker leaves a PROCESSING lease behind; a later worker reclaims stale
 *    leases and counts the abandoned attempt so events cannot remain stuck forever.
 * 4. Completion/failure updates require the exact claim token, preventing an old worker
 *    from overwriting a newer worker's result after lease recovery.
 * 5. The outbox event_id is forwarded as the WebSocket event identity, so a retry/replay
 *    can be deduplicated by clients and cross-node subscribers.
 */
class OutboxDispatcher {
  constructor({
    poolOrConfig,
    websocketService = null,
    pollIntervalMs = 1000,
    batchSize = 25,
    maxAttempts = 5,
    backoffBaseMs = 2000,
    backoffMaxMs = 60000,
    processingLeaseMs = 120000,
    aggregateTypeFilter = null,
    loggerInstance = null
  } = {}) {
    if (poolOrConfig && typeof poolOrConfig.query === 'function') {
      this.pool = poolOrConfig;
    } else {
      this.pool = new PostgresPool(poolOrConfig || {});
    }

    this.websocketService = websocketService;
    this.pollIntervalMs = pollIntervalMs;
    this.batchSize = batchSize;
    this.maxAttempts = maxAttempts;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.processingLeaseMs = processingLeaseMs;
    this.aggregateTypeFilter = aggregateTypeFilter || null;
    this.logger = loggerInstance || logger;

    this.isRunning = false;
    this.isPolling = false;
    this.timer = null;
    this.customHandlers = new Map();

    this.stats = {
      batchesProcessed: 0,
      eventsClaimed: 0,
      eventsPublished: 0,
      eventsRetried: 0,
      eventsRecovered: 0,
      eventsFailed: 0,
      lastPollAt: null
    };
  }

  registerHandler(eventType, handlerFn) {
    if (!this.customHandlers.has(eventType)) this.customHandlers.set(eventType, []);
    this.customHandlers.get(eventType).push(handlerFn);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNextPoll(0);
    this.logger.info('outbox_dispatcher_started', 'Transactional Outbox Dispatcher started', {
      intervalMs: this.pollIntervalMs,
      batchSize: this.batchSize,
      maxAttempts: this.maxAttempts,
      processingLeaseMs: this.processingLeaseMs
    });
  }

  async stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const start = Date.now();
    while (this.isPolling && (Date.now() - start < 5000)) {
      await new Promise(res => setTimeout(res, 50));
    }
    this.logger.info('outbox_dispatcher_stopped', 'Transactional Outbox Dispatcher stopped');
  }

  scheduleNextPoll(delayMs = this.pollIntervalMs) {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      try {
        await this.pollAndDispatch();
      } catch (err) {
        this.logger.error('outbox_dispatcher_poll_error', `Outbox poll cycle error: ${err.message}`, { error: err.stack });
      } finally {
        if (this.isRunning) this.scheduleNextPoll(this.pollIntervalMs);
      }
    }, delayMs);
    if (this.timer.unref) this.timer.unref();
  }

  _calculateNextAttempt(attemptCount) {
    const exp = Math.min(attemptCount, 6);
    const delay = Math.min(this.backoffBaseMs * Math.pow(2, exp), this.backoffMaxMs);
    const jitter = Math.floor(Math.random() * (delay * 0.2));
    return new Date(Date.now() + delay + jitter);
  }

  async _recoverStaleProcessing() {
    const recoveryThreshold = new Date(Date.now() - this.processingLeaseMs);
    const client = await this.pool.pool.connect();
    try {
      await client.query('BEGIN');
      const staleRes = await client.query(`
        SELECT outbox_id, event_id, attempt_count
        FROM payment_outbox
        WHERE status = 'PROCESSING'
          AND processing_started_at IS NOT NULL
          AND processing_started_at < $1
        FOR UPDATE SKIP LOCKED;
      `, [recoveryThreshold]);

      let recovered = 0;
      let failed = 0;
      for (const row of staleRes.rows) {
        const nextAttemptCount = Number(row.attempt_count || 0) + 1;
        if (nextAttemptCount >= this.maxAttempts) {
          await client.query(`
            UPDATE payment_outbox
            SET status = 'FAILED',
                attempt_count = $1,
                processing_started_at = NULL,
                claim_token = NULL,
                next_attempt_at = NULL,
                last_error = $2
            WHERE outbox_id = $3;
          `, [nextAttemptCount, 'Processing lease expired before the worker completed dispatch.', row.outbox_id]);
          failed++;
        } else {
          await client.query(`
            UPDATE payment_outbox
            SET status = 'PENDING',
                attempt_count = $1,
                processing_started_at = NULL,
                claim_token = NULL,
                next_attempt_at = NOW(),
                last_error = $2
            WHERE outbox_id = $3;
          `, [nextAttemptCount, 'Processing lease expired; event returned to the retry queue.', row.outbox_id]);
          recovered++;
        }
      }

      await client.query('COMMIT');
      this.stats.eventsRecovered += recovered;
      this.stats.eventsFailed += failed;
      if (recovered) metricsService.increment('outbox_processing_leases_recovered_total', recovered);
      if (failed) metricsService.increment('outbox_processing_leases_failed_total', failed);
      return { recovered, failed };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async _claimBatch() {
    const client = await this.pool.pool.connect();
    try {
      await client.query('BEGIN');
      let sql = `
        WITH candidates AS (
          SELECT outbox_id
          FROM payment_outbox
          WHERE status = 'PENDING'
            AND next_attempt_at <= NOW()
      `;
      const params = [];
      if (this.aggregateTypeFilter) {
        params.push(this.aggregateTypeFilter);
        sql += ` AND aggregate_type = $${params.length}`;
      }
      params.push(this.batchSize);
      sql += `
          ORDER BY created_at ASC
          LIMIT $${params.length}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE payment_outbox o
        SET status = 'PROCESSING',
            processing_started_at = NOW(),
            claim_token = md5(random()::text || clock_timestamp()::text || o.outbox_id::text)
        FROM candidates
        WHERE o.outbox_id = candidates.outbox_id
        RETURNING o.outbox_id, o.event_id, o.aggregate_type, o.aggregate_id,
                  o.event_type, o.payload, o.attempt_count, o.created_at,
                  o.status, o.claim_token;
      `;
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      this.stats.eventsClaimed += result.rows.length;
      if (result.rows.length) metricsService.increment('outbox_events_claimed_total', result.rows.length);
      return result.rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async pollAndDispatch() {
    if (this.isPolling) return 0;
    this.isPolling = true;
    this.stats.lastPollAt = new Date().toISOString();

    try {
      await this._recoverStaleProcessing();
      const events = await this._claimBatch();
      if (events.length === 0) return 0;
      this.stats.batchesProcessed++;

      for (const ev of events) {
        let payload;
        try {
          payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
          await this._dispatchEvent(ev.event_type, ev.aggregate_type, ev.aggregate_id, payload, ev.event_id);
          await this._markPublished(ev);
        } catch (err) {
          await this._markFailed(ev, err.message);
        }
      }
      return events.length;
    } finally {
      this.isPolling = false;
    }
  }

  async _markPublished(ev) {
    const result = await this.pool.query(`
      UPDATE payment_outbox
      SET status = 'PUBLISHED',
          published_at = NOW(),
          processing_started_at = NULL,
          claim_token = NULL,
          last_error = NULL
      WHERE outbox_id = $1 AND status = 'PROCESSING' AND claim_token = $2;
    `, [ev.outbox_id, ev.claim_token]);

    if (result.rowCount !== 1) {
      metricsService.increment('outbox_stale_claim_completion_total');
      this.logger.warn('outbox_stale_claim_completion', `Outbox event ${ev.event_id} was no longer owned by this worker`, { eventId: ev.event_id });
      return false;
    }
    this.stats.eventsPublished++;
    metricsService.increment('outbox_events_published_total');
    return true;
  }

  async _markFailed(ev, dispatchError) {
    const nextAttemptCount = Number(ev.attempt_count || 0) + 1;
    const exhausted = nextAttemptCount >= this.maxAttempts;
    const nextAttemptAt = exhausted ? null : this._calculateNextAttempt(nextAttemptCount);
    const result = await this.pool.query(`
      UPDATE payment_outbox
      SET status = $1,
          attempt_count = $2,
          next_attempt_at = $3,
          processing_started_at = NULL,
          claim_token = NULL,
          last_error = $4
      WHERE outbox_id = $5 AND status = 'PROCESSING' AND claim_token = $6;
    `, [exhausted ? 'FAILED' : 'PENDING', nextAttemptCount, nextAttemptAt, dispatchError, ev.outbox_id, ev.claim_token]);

    if (result.rowCount !== 1) {
      metricsService.increment('outbox_stale_claim_failure_total');
      this.logger.warn('outbox_stale_claim_failure', `Outbox event ${ev.event_id} lost its processing lease before failure was recorded`, { eventId: ev.event_id });
      return false;
    }

    if (exhausted) {
      this.stats.eventsFailed++;
      metricsService.increment('outbox_events_dlq_failed_total');
      this.logger.error('outbox_event_dlq_failed', `Event ${ev.event_id} failed permanently after ${nextAttemptCount} attempts: ${dispatchError}`, {
        eventId: ev.event_id,
        eventType: ev.event_type,
        error: dispatchError
      });
    } else {
      this.stats.eventsRetried++;
      metricsService.increment('outbox_events_retried_total');
    }
    return true;
  }

  async _dispatchEvent(eventType, aggregateType, aggregateId, payload, eventId) {
    if (this.websocketService) {
      const rooms = [];
      const tripId = payload.tripId || (aggregateType === 'PAYMENT' && String(aggregateId).startsWith('PAY_TRIP_') ? String(aggregateId).replace('PAY_TRIP_', 'TRIP_') : null);
      if (tripId) rooms.push(`trip:${tripId}`);
      if (payload.customerId) rooms.push(`customer:${payload.customerId}`);
      if (payload.driverId) rooms.push(`driver:${payload.driverId}`);
      rooms.push('fleet:all');
      rooms.push('admin:financial');

      const failures = [];
      for (const room of [...new Set(rooms)]) {
        try {
          await this.websocketService.broadcastToRoom(room, eventType, {
            aggregateType,
            aggregateId,
            ...payload
          }, { eventId });
        } catch (wsErr) {
          failures.push({ room, error: wsErr.message });
          this.logger.warn('outbox_ws_broadcast_warning', `WebSocket broadcast failed for room ${room}: ${wsErr.message}`, { eventId, room });
        }
      }
      if (failures.length) throw new Error(`WebSocket delivery failed for ${failures.length} room(s): ${failures.map(f => `${f.room}: ${f.error}`).join('; ')}`);
    }

    const handlers = this.customHandlers.get(eventType) || [];
    for (const fn of handlers) await fn({ eventType, aggregateType, aggregateId, payload, eventId });

    const wildcards = this.customHandlers.get('*') || [];
    for (const fn of wildcards) await fn({ eventType, aggregateType, aggregateId, payload, eventId });
  }

  async getDeadLetterEvents({ limit = 50, offset = 0 } = {}) {
    const res = await this.pool.query(`
      SELECT outbox_id, event_id, aggregate_type, aggregate_id, event_type, payload,
             attempt_count, created_at, published_at, last_error
      FROM payment_outbox
      WHERE status = 'FAILED'
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2;
    `, [limit, offset]);
    return res.rows.map(r => ({
      outboxId: r.outbox_id,
      eventId: r.event_id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      eventType: r.event_type,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      attemptCount: r.attempt_count,
      createdAt: r.created_at,
      lastError: r.last_error
    }));
  }

  async retryDeadLetterEvent(eventId) {
    const res = await this.pool.query(`
      UPDATE payment_outbox
      SET status = 'PENDING',
          attempt_count = 0,
          next_attempt_at = NOW(),
          processing_started_at = NULL,
          claim_token = NULL,
          last_error = NULL
      WHERE event_id = $1 AND status = 'FAILED'
      RETURNING event_id;
    `, [eventId]);
    return res.rowCount > 0;
  }

  async getStatus() {
    const countsRes = await this.pool.query(`
      SELECT status, COUNT(*) as count
      FROM payment_outbox
      GROUP BY status;
    `);
    const statusCounts = { PENDING: 0, PROCESSING: 0, PUBLISHED: 0, FAILED: 0 };
    for (const row of countsRes.rows) statusCounts[row.status] = parseInt(row.count, 10);

    return {
      isRunning: this.isRunning,
      isPolling: this.isPolling,
      stats: { ...this.stats },
      queue: statusCounts
    };
  }
}

module.exports = { OutboxDispatcher };
