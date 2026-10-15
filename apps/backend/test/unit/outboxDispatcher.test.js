'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { OutboxDispatcher } = require('../../src/services/ledger/outboxDispatcher');

test('VAAYU Phase F.3: Transactional Outbox Dispatcher Worker Test Suite', async (t) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip('Skipping PostgreSQL outbox dispatcher tests: DATABASE_ADMIN_URL not configured.');
    return;
  }

  const pool = new PostgresPool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 10000
  });
  const repo = new PostgresLedgerRepository(pool);

  // Clean stale test events so tests only see isolated events
  await pool.query("UPDATE payment_outbox SET status = 'PUBLISHED', published_at = NOW() WHERE status = 'PENDING'");

  // Mock WebSocket Service
  const deliveredWsMessages = [];
  const mockWebsocketService = {
    broadcastToRoom: async (room, eventName, payload) => {
      deliveredWsMessages.push({ room, eventName, payload });
      return 1;
    }
  };

  const dispatcher = new OutboxDispatcher({
    poolOrConfig: pool,
    websocketService: mockWebsocketService,
    pollIntervalMs: 50,
    batchSize: 10,
    maxAttempts: 3,
    backoffBaseMs: 100
  });

  t.after(async () => {
    await dispatcher.stop();
    await pool.end();
  });

  await t.test('1. Atomic Ledger Posting Inserts Outbox Event with PENDING Status', async () => {
    const tripId = `TRIP_F3_OUTBOX_1_${Date.now()}`;
    const customerId = `CUST_${Date.now()}`;

    // Top-up wallet first
    await repo.topUpCustomerWallet({
      customerId,
      amountPaise: 50000,
      idempotencyKey: `TOPUP_${tripId}`
    });

    // Reserve escrow hold
    const escrowRes = await repo.reserveEscrow({
      tripId,
      customerId,
      amountPaise: 30000,
      idempotencyKey: `ESCROW_${tripId}`
    });

    assert.equal(escrowRes.status, 'ESCROWED');

    // Verify outbox entry in postgres
    const outboxCheck = await pool.query(`
      SELECT status, event_type, aggregate_id, attempt_count
      FROM payment_outbox
      WHERE aggregate_id = $1;
    `, [`PAY_${tripId}`]);

    assert.equal(outboxCheck.rows.length, 1);
    assert.equal(outboxCheck.rows[0].status, 'PENDING');
    assert.equal(outboxCheck.rows[0].event_type, 'PaymentEscrowed');
    assert.equal(outboxCheck.rows[0].attempt_count, 0);
  });

  await t.test('2. Single Poll Cycle Dispatches Event & Marks PUBLISHED', async () => {
    deliveredWsMessages.length = 0;
    const handledEvents = [];
    dispatcher.registerHandler('PaymentEscrowed', async (ev) => {
      handledEvents.push(ev);
    });

    // Run poll cycle directly
    const processed = await dispatcher.pollAndDispatch();
    assert.ok(processed >= 1, 'Should have processed at least 1 pending event');

    // Check delivered to custom handler
    assert.ok(handledEvents.length >= 1, 'Custom event handler should have been invoked');

    // Check delivered to WebSockets
    assert.ok(deliveredWsMessages.length >= 1, 'Event should have been broadcast to websocket rooms');
    const wsEvent = deliveredWsMessages.find(m => m.eventName === 'PaymentEscrowed');
    assert.ok(wsEvent, 'Should find PaymentEscrowed ws event');

    // Verify database row status is updated to PUBLISHED
    const rowCheck = await pool.query(`
      SELECT status, published_at, last_error
      FROM payment_outbox
      WHERE aggregate_id = $1;
    `, [handledEvents[0].aggregateId]);

    assert.equal(rowCheck.rows[0].status, 'PUBLISHED');
    assert.ok(rowCheck.rows[0].published_at !== null, 'published_at should be populated');
    assert.equal(rowCheck.rows[0].last_error, null);
  });

  await t.test('3. Multi-Worker Competing Pollers (SKIP LOCKED Serialization)', async () => {
    // Insert 15 synthetic pending outbox events
    const batchId = `TEST_CONC_${Date.now()}`;
    for (let i = 0; i < 15; i++) {
      await pool.query(`
        INSERT INTO payment_outbox (event_id, aggregate_type, aggregate_id, event_type, payload, status)
        VALUES ($1, 'TEST', $2, 'TEST_EVENT', $3, 'PENDING');
      `, [`EVT_${batchId}_${i}`, `AGG_${batchId}_${i}`, JSON.stringify({ index: i, batchId })]);
    }

    // Spawn 3 concurrent dispatchers with distinct connection clients
    const dispatcherA = new OutboxDispatcher({ poolOrConfig: pool, batchSize: 5, pollIntervalMs: 100, aggregateTypeFilter: 'TEST' });
    const dispatcherB = new OutboxDispatcher({ poolOrConfig: pool, batchSize: 5, pollIntervalMs: 100, aggregateTypeFilter: 'TEST' });
    const dispatcherC = new OutboxDispatcher({ poolOrConfig: pool, batchSize: 5, pollIntervalMs: 100, aggregateTypeFilter: 'TEST' });

    const results = await Promise.all([
      dispatcherA.pollAndDispatch(),
      dispatcherB.pollAndDispatch(),
      dispatcherC.pollAndDispatch()
    ]);

    const totalProcessed = results.reduce((acc, count) => acc + count, 0);
    assert.equal(totalProcessed, 15, 'All 15 events must be processed exactly once without double-claiming');

    // Verify all 15 are now PUBLISHED
    const checkRes = await pool.query(`
      SELECT status FROM payment_outbox WHERE aggregate_id LIKE $1;
    `, [`AGG_${batchId}%`]);

    assert.equal(checkRes.rows.length, 15);
    assert.ok(checkRes.rows.every(r => r.status === 'PUBLISHED'), 'All events should be marked PUBLISHED');
  });

  await t.test('4. Transient Failures Trigger Exponential Backoff & Retry Attempts', async () => {
    const errorEventId = `EVT_FAIL_${Date.now()}`;
    await pool.query(`
      INSERT INTO payment_outbox (event_id, aggregate_type, aggregate_id, event_type, payload, status)
      VALUES ($1, 'TEST', 'FAIL_AGG_1', 'FAIL_EVENT', '{"test":true}', 'PENDING');
    `, [errorEventId]);

    // Dispatcher with a failing handler
    const failingDispatcher = new OutboxDispatcher({
      poolOrConfig: pool,
      batchSize: 5,
      maxAttempts: 3,
      backoffBaseMs: 50,
      aggregateTypeFilter: 'TEST'
    });
    failingDispatcher.registerHandler('FAIL_EVENT', async () => {
      throw new Error('Simulated transient webhook timeout');
    });

    // 1st Poll: Fails -> attempt_count becomes 1, next_attempt_at in future
    await failingDispatcher.pollAndDispatch();

    const afterFirst = await pool.query(`
      SELECT status, attempt_count, next_attempt_at, last_error
      FROM payment_outbox
      WHERE event_id = $1;
    `, [errorEventId]);

    assert.equal(afterFirst.rows[0].status, 'PENDING');
    assert.equal(afterFirst.rows[0].attempt_count, 1);
    assert.ok(afterFirst.rows[0].last_error.includes('Simulated transient webhook timeout'));
    assert.ok(new Date(afterFirst.rows[0].next_attempt_at) > new Date());
  });

  await t.test('5. Exhausted Retries Move Event to Dead Letter Queue (FAILED)', async () => {
    const dlqEventId = `EVT_DLQ_${Date.now()}`;
    await pool.query(`
      INSERT INTO payment_outbox (event_id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count)
      VALUES ($1, 'TEST', 'DLQ_AGG_1', 'DLQ_EVENT', '{"test":true}', 'PENDING', 2);
    `, [dlqEventId]);

    const dlqDispatcher = new OutboxDispatcher({
      poolOrConfig: pool,
      batchSize: 5,
      maxAttempts: 3,
      backoffBaseMs: 50,
      aggregateTypeFilter: 'TEST'
    });
    dlqDispatcher.registerHandler('DLQ_EVENT', async () => {
      throw new Error('Fatal downstream gateway crash');
    });

    // 3rd attempt -> exceeds maxAttempts (3) -> status becomes FAILED
    await dlqDispatcher.pollAndDispatch();

    const afterDlq = await pool.query(`
      SELECT status, attempt_count, last_error
      FROM payment_outbox
      WHERE event_id = $1;
    `, [dlqEventId]);

    assert.equal(afterDlq.rows[0].status, 'FAILED');
    assert.equal(afterDlq.rows[0].attempt_count, 3);
    assert.ok(afterDlq.rows[0].last_error.includes('Fatal downstream gateway crash'));

    // Verify DLQ Inspection API
    const dlqList = await dlqDispatcher.getDeadLetterEvents();
    assert.ok(dlqList.some(e => e.eventId === dlqEventId));

    // Verify DLQ Replay API
    const retried = await dlqDispatcher.retryDeadLetterEvent(dlqEventId);
    assert.equal(retried, true);

    const recheck = await pool.query(`
      SELECT status, attempt_count FROM payment_outbox WHERE event_id = $1;
    `, [dlqEventId]);
    assert.equal(recheck.rows[0].status, 'PENDING');
    assert.equal(recheck.rows[0].attempt_count, 0);
  });

  await t.test('6. Graceful Start and Stop Lifecycle', async () => {
    const lifecycleDispatcher = new OutboxDispatcher({
      poolOrConfig: pool,
      pollIntervalMs: 50
    });

    lifecycleDispatcher.start();
    assert.equal(lifecycleDispatcher.isRunning, true);

    const status1 = await lifecycleDispatcher.getStatus();
    assert.equal(status1.isRunning, true);

    await lifecycleDispatcher.stop();
    assert.equal(lifecycleDispatcher.isRunning, false);
  });
});
