'use strict';

const crypto = require('crypto');
const { PostgresPool } = require('../../db/postgresClient');
const { metricsService } = require('../metricsService');
const { logger } = require('../logger');

/**
 * VAAYU TRANSACTIONAL OUTBOX DISPATCHER WORKER (Phase F.3)
 * 
 * Responsibilities:
 * 1. Polls `payment_outbox` periodically using `FOR UPDATE SKIP LOCKED`
 *    so multiple clustered workers never compete or double-dispatch.
 * 2. Emits domain events to WebSocket streams (Trip, Driver, Customer, Fleet) and registered handlers.
 * 3. Enforces exponential backoff retry on transient dispatch failures with jitter.
 * 4. Moves continuously failing records to 'FAILED' (Dead Letter Queue) after `maxAttempts`.
 * 5. Provides manual retry/replay functionality for DLQ inspection and recovery.
 * 6. Clean graceful shutdown support (draining inflight batch before termination).
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
    this.logger = loggerInstance || logger;
    this.aggregateTypeFilter = aggregateTypeFilter || null;

    this.isRunning = false;
    this.isPolling = false;
    this.timer = null;
    this.customHandlers = new Map();

    this.stats = {
      batchesProcessed: 0,
      eventsPublished: 0,
      eventsRetried: 0,
      eventsFailed: 0,
      lastPollAt: null
    };
  }

  /**
   * Register a custom domain event listener (e.g. for external webhooks or telemetry)
   */
  registerHandler(eventType, handlerFn) {
    if (!this.customHandlers.has(eventType)) {
      this.customHandlers.set(eventType, []);
    }
    this.customHandlers.get(eventType).push(handlerFn);
  }

  /**
   * Start the background dispatcher loop
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNextPoll(0);
    this.logger.info('outbox_dispatcher_started', 'Transactional Outbox Dispatcher started', {
      intervalMs: this.pollIntervalMs,
      batchSize: this.batchSize,
      maxAttempts: this.maxAttempts
    });
  }

  /**
   * Stop the background dispatcher loop and wait for any active poll to complete
   */
  async stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Wait if a poll cycle is actively running
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
        if (this.isRunning) {
          this.scheduleNextPoll(this.pollIntervalMs);
        }
      }
    }, delayMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Compute exponential backoff with jitter
   */
  _calculateNextAttempt(attemptCount) {
    const exp = Math.min(attemptCount, 6);
    const delay = Math.min(this.backoffBaseMs * Math.pow(2, exp), this.backoffMaxMs);
    const jitter = Math.floor(Math.random() * (delay * 0.2));
    const totalDelay = delay + jitter;
    return new Date(Date.now() + totalDelay);
  }

  /**
   * Execute single poll-and-dispatch batch
   * Uses `FOR UPDATE SKIP LOCKED` inside a transaction for multi-worker safety.
   */
  async pollAndDispatch() {
    if (this.isPolling) return 0;
    this.isPolling = true;
    this.stats.lastPollAt = new Date().toISOString();

    let client;
    try {
      client = await this.pool.pool.connect();
    } catch (err) {
      this.isPolling = false;
      throw err;
    }

    try {
      await client.query('BEGIN');

      // 1. Fetch pending events ready for dispatch using SKIP LOCKED
      let selectSql = `
        SELECT outbox_id, event_id, aggregate_type, aggregate_id, event_type, payload,
               attempt_count, created_at, status
        FROM payment_outbox
        WHERE status = 'PENDING'
          AND next_attempt_at <= NOW()
      `;
      const params = [];
      if (this.aggregateTypeFilter) {
        params.push(this.aggregateTypeFilter);
        selectSql += ` AND aggregate_type = $${params.length} `;
      }
      params.push(this.batchSize);
      selectSql += `
        ORDER BY created_at ASC
        LIMIT $${params.length}
        FOR UPDATE SKIP LOCKED;
      `;
      const res = await client.query(selectSql, params);
      const events = res.rows;

      if (events.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      this.stats.batchesProcessed++;

      // 2. Dispatch each event
      for (const ev of events) {
        const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
        let dispatchSuccess = false;
        let dispatchError = null;

        try {
          await this._dispatchEvent(ev.event_type, ev.aggregate_type, ev.aggregate_id, payload);
          dispatchSuccess = true;
        } catch (err) {
          dispatchSuccess = false;
          dispatchError = err.message;
        }

        if (dispatchSuccess) {
          // Mark as published
          await client.query(`
            UPDATE payment_outbox
            SET status = 'PUBLISHED',
                published_at = NOW(),
                last_error = NULL
            WHERE outbox_id = $1;
          `, [ev.outbox_id]);

          this.stats.eventsPublished++;
          metricsService.increment('outbox_events_published_total');
        } else {
          // Handle retry or DLQ failure
          const nextAttemptCount = ev.attempt_count + 1;
          if (nextAttemptCount >= this.maxAttempts) {
            // Move to Dead Letter Queue (FAILED)
            await client.query(`
              UPDATE payment_outbox
              SET status = 'FAILED',
                  attempt_count = $1,
                  last_error = $2
              WHERE outbox_id = $3;
            `, [nextAttemptCount, dispatchError, ev.outbox_id]);

            this.stats.eventsFailed++;
            metricsService.increment('outbox_events_dlq_failed_total');
            this.logger.error('outbox_event_dlq_failed', `Event ${ev.event_id} failed permanently after ${nextAttemptCount} attempts: ${dispatchError}`, {
              eventId: ev.event_id,
              eventType: ev.event_type,
              error: dispatchError
            });
          } else {
            // Schedule next attempt with exponential backoff
            const nextAttemptAt = this._calculateNextAttempt(nextAttemptCount);
            await client.query(`
              UPDATE payment_outbox
              SET attempt_count = $1,
                  next_attempt_at = $2,
                  last_error = $3
              WHERE outbox_id = $4;
            `, [nextAttemptCount, nextAttemptAt, dispatchError, ev.outbox_id]);

            this.stats.eventsRetried++;
            metricsService.increment('outbox_events_retried_total');
          }
        }
      }

      await client.query('COMMIT');
      return events.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
      this.isPolling = false;
    }
  }

  /**
   * Internal dispatcher logic: sends to WebSockets, Redis, and custom event handlers
   */
  async _dispatchEvent(eventType, aggregateType, aggregateId, payload) {
    // 1. Broadcast via WebSocket if available
    if (this.websocketService) {
      // Determine relevant target rooms based on event context
      const rooms = [];

      // Trip room
      const tripId = payload.tripId || (aggregateType === 'PAYMENT' && aggregateId.startsWith('PAY_TRIP_') ? aggregateId.replace('PAY_TRIP_', 'TRIP_') : null);
      if (tripId) rooms.push(`trip:${tripId}`);

      // Customer stream room
      if (payload.customerId) rooms.push(`customer:${payload.customerId}`);

      // Driver stream room
      if (payload.driverId) rooms.push(`driver:${payload.driverId}`);

      // Admin / Fleet rooms for settlements & disputes
      rooms.push('fleet:all');
      rooms.push('admin:financial');

      for (const room of [...new Set(rooms)]) {
        try {
          await this.websocketService.broadcastToRoom(room, eventType, {
            aggregateType,
            aggregateId,
            ...payload
          });
        } catch (wsErr) {
          // Log but do not break other channels
          this.logger.warn('outbox_ws_broadcast_warning', `WebSocket broadcast failed for room ${room}: ${wsErr.message}`);
        }
      }
    }

    // 2. Invoke any custom registered domain handlers
    const handlers = this.customHandlers.get(eventType) || [];
    for (const fn of handlers) {
      await fn({ eventType, aggregateType, aggregateId, payload });
    }

    // 3. Handlers for universal wildcard '*'
    const wildcards = this.customHandlers.get('*') || [];
    for (const fn of wildcards) {
      await fn({ eventType, aggregateType, aggregateId, payload });
    }
  }

  /**
   * DLQ Inspection: Query failed events
   */
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

  /**
   * DLQ Manual Recovery: Reset failed event(s) back to PENDING for re-dispatching
   */
  async retryDeadLetterEvent(eventId) {
    const res = await this.pool.query(`
      UPDATE payment_outbox
      SET status = 'PENDING',
          attempt_count = 0,
          next_attempt_at = NOW(),
          last_error = NULL
      WHERE event_id = $1 AND status = 'FAILED'
      RETURNING event_id;
    `, [eventId]);
    return res.rowCount > 0;
  }

  /**
   * Get outbox metrics / status
   */
  async getStatus() {
    const countsRes = await this.pool.query(`
      SELECT status, COUNT(*) as count
      FROM payment_outbox
      GROUP BY status;
    `);
    const statusCounts = { PENDING: 0, PUBLISHED: 0, FAILED: 0 };
    for (const row of countsRes.rows) {
      statusCounts[row.status] = parseInt(row.count, 10);
    }

    return {
      isRunning: this.isRunning,
      isPolling: this.isPolling,
      stats: { ...this.stats },
      queue: statusCounts
    };
  }
}

module.exports = {
  OutboxDispatcher
};
