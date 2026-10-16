'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { OutboxDispatcher } = require('../../src/services/ledger/outboxDispatcher');

test('VAAYU Phase F.3: Transactional Outbox Dispatcher Worker Test Suite', async (t) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip('Skipping PostgreSQL outbox dispatcher tests: DATABASE_ADMIN_URL not configured.');
    return;
  }

  const pool = new PostgresPool({ connectionString, max: 10, connectionTimeoutMillis: 10000 });
  const repo = new PostgresLedgerRepository(pool);

  // Clean stale test events so tests only see isolated events.
  await pool.query("UPDATE payment_outbox SET status = 'PUBLISHED', published_at = NOW(), processing_started_at = NULL, claim_token = NULL WHERE status IN ('PENDING', 'PROCESSING')");

  const deliveredWsMessages = [];
  const mockWebsocketService = {
    broadcastToRoom: async (room, eventName, payload, options = {}) => {
      deliveredWsMessages.push({ room, eventName, payload, options });
      return 1;
    }
  };

  const dispatcher = new OutboxDispatcher({
    poolOrConfig: pool,
    websocketService: mockWebsocketService,
    pollIntervalMs: 50,
    batchSize: 10,
    maxAttempts: 3,
    backoffBaseMs: 100,
    processingLeaseMs: 1000
  });

  t.after(async () => {
    await dispatcher.stop();
    await pool.end();
  });

  await t.test('1. Atomic Ledger Posting Inserts Outbox Event with PENDING Status', async () => {
    const tripId = `TRIP_F3_OUTBOX_1_${Date.now()}`;
    const customerId = `CUST_${Date.now()}`;
    await repo.topUpCustomerWallet({ customerId, amountPaise: 50000, idempotencyKey: `TOPUP_${tripId}` });
    const escrowRes = await repo.reserveEscrow({ tripId, customerId, amountPaise: 30000, idempotencyKey: `ESCROW_${tripId}` });
    assert.equal(escrowRes.status, 'ESCROWED');

    const outboxCheck = await pool.query(`
      SELECT status, event_type, aggregate_id, attempt_count, claim_token
      FROM payment_outbox WHERE aggregate_id = $1;
    `, [`PAY_${tripId}`]);
    assert.equal(outboxCheck.rows.length, 1);
    assert.equal(outboxCheck.rows[0].status, 'PENDING');
    assert.equal(outboxCheck.rows[0].event_type, 'PaymentEscrowed');
    assert.equal(outboxCheck.rows[0].attempt_count, 0);
    assert.equal(outboxCheck.rows[0].claim_token, null);
  });

  await t.test('2. Single Poll Claims, Dispatches, and Marks PUBLISHED with Stable Event Identity', async () => {
    deliveredWsMessages.length = 0;
    const handledEvents = [];
    dispatcher.registerHandler('PaymentEscrowed', async (ev) => handledEvents.push(ev));

    const processed = await dispatcher.pollAndDispatch();
    assert.ok(processed >= 1);
    assert.ok(handledEvents.length >= 1);
    assert.ok(deliveredWsMessages.length >= 1);
    const wsEvent = deliveredWsMessages.find(m => m.eventName === 'PaymentEscrowed');
    assert.ok(wsEvent);
    assert.equal(wsEvent.options.eventId, handledEvents[0].eventId);

    const rowCheck = await pool.query(`
      SELECT status, published_at, last_error, processing_started_at, claim_token
      FROM payment_outbox WHERE aggregate_id = $1;
    `, [handledEvents[0].aggregateId]);
    assert.equal(rowCheck.rows[0].status, 'PUBLISHED');
    assert.ok(rowCheck.rows[0].published_at !== null);
    assert.equal(rowCheck.rows[0].last_error, null);
    assert.equal(rowCheck.rows[0].processing_started_at, null);
    assert.equal(rowCheck.rows[0].claim_token, null);
  });

  await t.test('3. Multi-Worker Competing Pollers Claim Each Event Exactly Once', async () => {
    const batchId = `TEST_CONC_${Date.now()}`;
    for (let i = 0; i < 15; i++) {
      await pool.query(`
        INSERT INTO payment_outbox (event_id, aggregate_type, aggregate_id, event_type, payload, status)
        VALUES ($1, 'TEST', $2, 'TEST_EVENT', $3, 'PENDING');
      `, [`EVT_${batchId}_${i}`, `AGG_${batchId}_${i}`, JSON.stringify({ index: i, batchId })]);
    }

    const dispatcherA = new OutboxDispatcher({ poolOrConfig: pool, batchSize: 5, aggregateTypeFilter: 'TEST' });
    const dispatcherB = new OutboxDispatcher({ poolOrConfig: pool, batchSize: 5, aggregateTypeFilter: 'TEST' });
    const dispatcherC = new OutboxDispatcher({ poolOrConfig: pool, batchSize: 5, aggregateTypeFilter: 'TEST' });
    const results = await Promise.all([
      dispatcherA.pollAndDispatch(), dispatcherB.pollAndDispatch(), dispatcherC.pollAndDispatch()
    ]);
    assert.equal(results.reduce((acc, count) => acc + count, 0), 15);

    const checkRes = await pool.query(`SELECT status FROM payment_outbox WHERE aggregate_id LIKE $1`, [`AGG_${batchId}%`]);
    assert.equal(checkRes.rows.length, 15);
    assert.ok(checkRes.rows.every(r => r.status === 'PUBLISHED'));
  });

  await t.test('4. Stale Processing Lease Is Recovered and Retried', async () => {
    const staleEventId = `EVT_STALE_${Date.now()}`;
    await pool.query(`
      INSERT INTO payment_outbox (
        event_id, aggregate_type, aggregate_id, event_type, payload, status,
        attempt_count, processing_started_at, claim_token
      ) VALUES ($1, 'TEST', 'STALE_AGG_1', 'STALE_EVENT', '{"test":true}', 'PROCESSING', 0, NOW() - INTERVAL '10 minutes', 'stale-worker-token');
    `, [staleEventId]);

    const recoveryDispatcher = new OutboxDispatcher({
      poolOrConfig: pool,
      batchSize: 5,
      maxAttempts: 3,
      processingLeaseMs: 1000,
      aggregateTypeFilter: 'TEST'
    });
    recoveryDispatcher.registerHandler('STALE_EVENT', async () => {});

    await recoveryDispatcher.pollAndDispatch();
    const row = await pool.query(`SELECT status, attempt_count, claim_token, processing_started_at FROM payment_outbox WHERE event_id = $1`, [staleEventId]);
    assert.equal(row.rows[0].status, 'PUBLISHED');
    assert.equal(row.rows[0].attempt_count, 1);
    assert.equal(row.rows[0].claim_token, null);
    assert.equal(row.rows[0].processing_started_at, null);
    assert.equal(recoveryDispatcher.stats.eventsRecovered, 1);
  });

  await t.test('5. Transient Failures Trigger Backoff Without Holding a DB Transaction', async () => {
    const errorEventId = `EVT_FAIL_${Date.now()}`;
    await pool.query(`
      INSERT INTO payment_outbox (event_id, aggregate_type, aggregate_id, event_type, payload, status)
      VALUES ($1, 'TEST', 'FAIL_AGG_1', 'FAIL_EVENT', '{"test":true}', 'PENDING');
    `, [errorEventId]);

    const failingDispatcher = new OutboxDispatcher({ poolOrConfig: pool, batchSize: 5, maxAttempts: 3, backoffBaseMs: 50, aggregateTypeFilter: 'TEST' });
    failingDispatcher.registerHandler('FAIL_EVENT', async () => { throw new Error('Simulated transient webhook timeout'); });
    await failingDispatcher.pollAndDispatch();

    const afterFirst = await pool.query(`
      SELECT status, attempt_count, next_attempt_at, last_error, processing_started_at, claim_token
      FROM payment_outbox WHERE event_id = $1;
    `, [errorEventId]);
    assert.equal(afterFirst.rows[0].status, 'PENDING');
    assert.equal(afterFirst.rows[0].attempt_count, 1);
    assert.ok(afterFirst.rows[0].last_error.includes('Simulated transient webhook timeout'));
    assert.ok(new Date(afterFirst.rows[0].next_attempt_at) > new Date());
    assert.equal(afterFirst.rows[0].processing_started_at, null);
    assert.equal(afterFirst.rows[0].claim_token, null);
  });

  await t.test('6. Exhausted Retries Move Event to DLQ and Can Be Replayed', async () => {
    const dlqEventId = `EVT_DLQ_${Date.now()}`;
    await pool.query(`
      INSERT INTO payment_outbox (event_id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count)
      VALUES ($1, 'TEST', 'DLQ_AGG_1', 'DLQ_EVENT', '{"test":true}', 'PENDING', 2);
    `, [dlqEventId]);

    const dlqDispatcher = new OutboxDispatcher({ poolOrConfig: pool, batchSize: 5, maxAttempts: 3, backoffBaseMs: 50, aggregateTypeFilter: 'TEST' });
    dlqDispatcher.registerHandler('DLQ_EVENT', async () => { throw new Error('Fatal downstream gateway crash'); });
    await dlqDispatcher.pollAndDispatch();

    const afterDlq = await pool.query(`SELECT status, attempt_count, last_error FROM payment_outbox WHERE event_id = $1`, [dlqEventId]);
    assert.equal(afterDlq.rows[0].status, 'FAILED');
    assert.equal(afterDlq.rows[0].attempt_count, 3);
    assert.ok(afterDlq.rows[0].last_error.includes('Fatal downstream gateway crash'));
    assert.ok((await dlqDispatcher.getDeadLetterEvents()).some(e => e.eventId === dlqEventId));
    assert.equal(await dlqDispatcher.retryDeadLetterEvent(dlqEventId), true);

    const recheck = await pool.query(`SELECT status, attempt_count, claim_token FROM payment_outbox WHERE event_id = $1`, [dlqEventId]);
    assert.equal(recheck.rows[0].status, 'PENDING');
    assert.equal(recheck.rows[0].attempt_count, 0);
    assert.equal(recheck.rows[0].claim_token, null);
  });

  await t.test('7. Graceful Start and Stop Lifecycle', async () => {
    const lifecycleDispatcher = new OutboxDispatcher({ poolOrConfig: pool, pollIntervalMs: 50 });
    lifecycleDispatcher.start();
    assert.equal(lifecycleDispatcher.isRunning, true);
    assert.equal((await lifecycleDispatcher.getStatus()).isRunning, true);
    await lifecycleDispatcher.stop();
    assert.equal(lifecycleDispatcher.isRunning, false);
  });
});
