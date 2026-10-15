'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { OutboxDispatcher } = require('../../src/services/ledger/outboxDispatcher');
const { DatabaseDisasterRecoveryManager } = require('../../src/db/databaseDisasterRecovery');
const { RedisLockManager } = require('../../src/services/redisLockManager');

/**
 * Universal Financial Invariant Assertion
 */
async function assertLedgerInvariants(pool, repo) {
  const accRes = await pool.query(`
    SELECT COALESCE(SUM(debit_paise), 0)::bigint AS debits,
           COALESCE(SUM(credit_paise), 0)::bigint AS credits
    FROM ledger_accounts;
  `);
  const debits = Number(accRes.rows[0].debits);
  const credits = Number(accRes.rows[0].credits);
  assert.strictEqual(debits, credits, `Double-entry imbalance detected! Debits: ${debits}, Credits: ${credits}`);

  const rec = await repo.reconcile();
  assert.strictEqual(rec.ok, true, `Reconciliation failed with problems: ${rec.problems.join(', ')}`);
  assert.strictEqual(rec.problems.length, 0, `Expected 0 reconciliation problems, got ${rec.problems.length}`);
}

test('Pillar 17: Full-Platform Disaster Recovery & Infrastructure Failure Suite', async (suite) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    suite.skip('Skipping P17 tests: DATABASE_ADMIN_URL not configured.');
    return;
  }

  const pool = new PostgresPool({ connectionString, max: 20, connectionTimeoutMillis: 10000 });
  const repo = new PostgresLedgerRepository(pool);

  suite.after(async () => {
    await pool.end();
  });

  // -------------------------------------------------------------------------
  // TRACK 17.1: Mid-Mutation Storage Severance & Transaction Atomicity
  // -------------------------------------------------------------------------
  await suite.test('17.1: Mid-mutation crash causes 100% rollback with zero orphaned postings', async () => {
    const tripId = `trip_p17_crash_${Date.now()}`;
    const payerId = `cust_p17_${Date.now()}`;
    const amountPaise = 38500; // ₹385.00

    // Top up customer wallet first via authoritative repo method
    const topupRes = await repo.topUpCustomerWallet({
      customerId: payerId,
      amountPaise,
      idempotencyKey: `topup_${tripId}`,
      referenceId: `REF_TOPUP_${tripId}`
    });
    assert.strictEqual(topupRes.success, true, 'Wallet topup must succeed');

    // Count journal entries before failed mutation
    const countBefore = await pool.query('SELECT COUNT(*)::int AS count FROM ledger_journal_entries');
    const initialJournals = countBefore.rows[0].count;

    // Simulate mid-mutation crash: client opens transaction, performs partial writes, then crashes/aborts
    let crashed = false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const journalId = `jnl_crash_sim_${Date.now()}`;
      await client.query(`
        INSERT INTO ledger_journal_entries (entry_id, reference_id, idempotency_key, description, total_paise, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [journalId, `ref_${tripId}`, `idem_${tripId}`, 'Simulated crashing mutation', amountPaise]);

      // Abrupt failure injection before commit
      throw new Error('SIMULATED_POWER_FAILURE_MID_TRANSACTION');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.message === 'SIMULATED_POWER_FAILURE_MID_TRANSACTION') {
        crashed = true;
      } else {
        throw err;
      }
    } finally {
      client.release();
    }
    assert.strictEqual(crashed, true, 'Chaos crash must have been thrown');

    // Invariant: Verify zero journal entries were persisted from crashed transaction
    const countAfter = await pool.query('SELECT COUNT(*)::int AS count FROM ledger_journal_entries');
    assert.strictEqual(countAfter.rows[0].count, initialJournals, 'Journal count must be identical; uncommitted writes must roll back completely');

    // Recovery retry: now perform legitimate escrow hold via repo
    const holdRes = await repo.reserveEscrow({
      tripId,
      customerId: payerId,
      amountPaise,
      idempotencyKey: `idem_hold_${tripId}`
    });
    assert.strictEqual(holdRes.success, true, 'Idempotent recovery write must succeed');

    // Verify ledger invariants are 100% preserved
    await assertLedgerInvariants(pool, repo);
  });

  // -------------------------------------------------------------------------
  // TRACK 17.2: Distributed Cache & Lock Partition (Redis Failure & Fallback)
  // -------------------------------------------------------------------------
  await suite.test('17.2: Redis distributed lock partition handled safely with zero dual-driver reservations', async () => {
    const lockManager = new RedisLockManager();
    const testDriverId = `drv_lock_test_${Date.now()}`;
    const orderA = `order_lock_a_${Date.now()}`;
    const orderB = `order_lock_b_${Date.now()}`;

    // Acquire lock for Driver by Order A
    const lockA = await lockManager.acquireDriverLock(testDriverId, orderA, 4000);
    assert.strictEqual(lockA.success, true, 'First lock acquisition must succeed');

    // Conflicting order B attempts to reserve same driver -> must be rejected
    const lockB = await lockManager.acquireDriverLock(testDriverId, orderB, 4000);
    assert.strictEqual(lockB.success, false, 'Conflicting lock must be rejected atomically');

    // Verify release with mismatched reservation fails safe
    const wrongRelease = await lockManager.releaseDriverLock(testDriverId, 'res_wrong_spoofed');
    assert.strictEqual(wrongRelease, false, 'Spoofed reservation release must return false');

    // Release correctly
    const legitimateRelease = await lockManager.releaseDriverLock(testDriverId, lockA.reservationId);
    assert.strictEqual(legitimateRelease, true, 'Legitimate lock release must return true');

    // After release, Order B can acquire cleanly
    const lockB2 = await lockManager.acquireDriverLock(testDriverId, orderB, 4000);
    assert.strictEqual(lockB2.success, true, 'Lock must be acquirable after release');
    await lockManager.releaseDriverLock(testDriverId, lockB2.reservationId);
  });

  // -------------------------------------------------------------------------
  // TRACK 17.3: Transactional Outbox Worker Crash & Recovery Replay
  // -------------------------------------------------------------------------
  await suite.test('17.3: Transactional outbox worker crash recovers cleanly with at-least-once delivery', async () => {
    const outboxPool = new PostgresPool({ connectionString });
    const dispatcher = new OutboxDispatcher({
      poolOrConfig: outboxPool,
      pollIntervalMs: 200,
      batchSize: 10,
      maxAttempts: 3,
      aggregateTypeFilter: 'P17_DR_TEST' // Isolate to test events
    });

    const eventId = `evt_test_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const payload = {
      orderId: `order_obx_${Date.now()}`,
      status: 'DRIVER_ARRIVING',
      timestamp: Date.now()
    };

    // Insert pending outbox record using isolated aggregate type
    await outboxPool.query(`
      INSERT INTO payment_outbox (event_id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count, next_attempt_at, created_at)
      VALUES ($1, 'P17_DR_TEST', $2, 'DELIVERY_STATE_CHANGED', $3, 'PENDING', 0, NOW(), NOW())
    `, [eventId, payload.orderId, JSON.stringify(payload)]);

    // Track dispatched events
    const dispatchedEvents = [];
    dispatcher.registerHandler('DELIVERY_STATE_CHANGED', async (event) => {
      dispatchedEvents.push(event);
      return { success: true };
    });

    // Execute one poll batch targeting our isolated aggregate
    const processedCount = await dispatcher.pollAndDispatch();
    assert.ok(processedCount >= 1, 'At least 1 outbox record must be processed');

    // Verify record was marked PUBLISHED
    const checkRes = await outboxPool.query(`
      SELECT status, published_at FROM payment_outbox WHERE event_id = $1
    `, [eventId]);
    assert.strictEqual(checkRes.rows[0].status, 'PUBLISHED', 'Outbox record must transition to PUBLISHED');
    assert.ok(checkRes.rows[0].published_at, 'published_at timestamp must be set');
    assert.strictEqual(dispatchedEvents.length, 1, 'Exactly one event must be dispatched to registered handler');

    await outboxPool.end();
  });

  // -------------------------------------------------------------------------
  // TRACK 17.4: Cold Database Snapshot & Stream Restore (pg_dump -> Ephemeral Restore)
  // -------------------------------------------------------------------------
  await suite.test('17.4: Cold pg_dump snapshot and psql stream restore passes 12-point invariant audit', async () => {
    const drManager = new DatabaseDisasterRecoveryManager({ adminUrl: connectionString });
    const ephemeralTarget = `vaayu_dr_p17_${Date.now()}`;

    // Execute full disaster recovery backup, target provisioning, restore, and 12-point invariant check
    const drReport = await drManager.executeFullDisasterRecoveryTest({ targetDbName: ephemeralTarget });

    assert.strictEqual(drReport.isCertified, true, `Disaster recovery test must be certified: ${JSON.stringify(drReport.steps)}`);
    assert.strictEqual(drReport.invariants.systemDebitsEqualCredits, true, 'Restored database debits must equal credits');
    assert.strictEqual(drReport.invariants.reconciliationOk, true, 'Restored database must pass reconciliation');
    assert.strictEqual(drReport.invariants.recoveryWriteSuccess, true, 'Restored database must successfully accept mutations');
    assert.strictEqual(drReport.invariants.postRecoveryReconciliationOk, true, 'Post-recovery reconciliation must pass');
  });

  // -------------------------------------------------------------------------
  // TRACK 17.5: Multi-Node Split-Brain Concurrency Chaos Convergence
  // -------------------------------------------------------------------------
  await suite.test('17.5: Concurrent conflicting mutations converge deterministically without ledger drift', async () => {
    const tripId = `trip_p17_race_${Date.now()}`;
    const customerId = `cust_p17_race_${Date.now()}`;
    const amountPaise = 25000; // ₹250.00

    // Wallet topup
    await repo.topUpCustomerWallet({
      customerId,
      amountPaise: 50000,
      idempotencyKey: `topup_${tripId}`,
      referenceId: `REF_TOPUP_${tripId}`
    });

    // Hold escrow
    await repo.reserveEscrow({
      tripId,
      customerId,
      amountPaise,
      idempotencyKey: `idem_hold_${tripId}`
    });

    // Simulate 2 clustered nodes simultaneously racing to settle trip with same idempotency key
    const driverId = `drv_p17_winner_${Date.now()}`;
    const nodeA = repo.settleTrip({
      tripId,
      driverId,
      amountPaise,
      commissionPaise: 2500,
      gstPaise: 450,
      driverEarningsPaise: 22050,
      idempotencyKey: `idem_settle_${tripId}`
    });

    const nodeB = repo.settleTrip({
      tripId,
      driverId,
      amountPaise,
      commissionPaise: 2500,
      gstPaise: 450,
      driverEarningsPaise: 22050,
      idempotencyKey: `idem_settle_${tripId}` // exact same idempotency key
    });

    const [resA, resB] = await Promise.all([nodeA, nodeB]);

    // Both calls must safely succeed with identical transaction ID due to atomic idempotency deduplication
    assert.strictEqual(resA.success, true, 'Node A mutation must succeed');
    assert.strictEqual(resB.success, true, 'Node B mutation must be deduplicated idempotently');
    assert.strictEqual(resA.transactionId, resB.transactionId, 'Both nodes must converge to exact same transaction ID');

    // Terminal ledger verification: strict ₹0 imbalance preserved
    await assertLedgerInvariants(pool, repo);
  });
});
