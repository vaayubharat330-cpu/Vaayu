'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const { RazorpayProvider } = require('../../src/services/ledger/providers/razorpayProvider');
const { PaymentIngestionService } = require('../../src/services/ledger/paymentIngestionService');
const { ProviderReconciliationWorker } = require('../../src/services/ledger/providerReconciliationWorker');
const { OutboxDispatcher } = require('../../src/services/ledger/outboxDispatcher');
const { FinancialSecurityService } = require('../../src/services/ledger/financialSecurityService');
const { runMigrations } = require('../../src/db/runLedgerMigrations');

/**
 * Universal Invariant Checker
 * Asserts:
 * 1. Total debits === Total credits across ledger accounts
 * 2. Materialized account balances === Calculated journal postings sum
 * 3. Zero balance drift or mathematical corruption
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
  assert.strictEqual(rec.ok, true, `Reconciliation problems: ${rec.problems.join(', ')}`);
  assert.strictEqual(rec.problems.length, 0);
}

test('VAAYU Phase F.7: Chaos, Fault Injection & Disaster Recovery Test Suite', async (t) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip('Skipping F.7 chaos tests: DATABASE_ADMIN_URL not configured.');
    return;
  }

  await runMigrations();

  const pool = new PostgresPool({ connectionString, max: 30, connectionTimeoutMillis: 15000 });
  const repo = new PostgresLedgerRepository(pool);
  const psm = new PaymentStateMachine({ ledgerService: repo });
  const integrationService = new PaymentIntegrationService({ paymentStateMachine: psm, ledgerService: repo });

  const webhookSecret = 'vaayu_test_webhook_secret_key_12345';
  const razorpay = new RazorpayProvider({
    keyId: 'rzp_test_123',
    keySecret: 'rzp_secret_456',
    webhookSecret
  });

  const ingestionService = new PaymentIngestionService({
    poolOrConfig: pool,
    paymentIntegrationService: integrationService,
    webhookSecret
  });
  ingestionService.registerProvider('razorpay', razorpay);

  const securityService = new FinancialSecurityService({
    poolOrConfig: pool,
    paymentIntegrationService: integrationService
  });

  const chaosPrefix = `CHAOS_${Date.now()}`;

  t.after(async () => {
    await pool.end();
  });

  // ===========================================================================
  // 1. MID-TRANSACTION CRASH INJECTION AT EXECUTION BOUNDARIES
  // ===========================================================================
  await t.test('1. Mid-Transaction Failure at Every Execution Boundary (Crash / Abort Injection)', async () => {
    const custId = `CUST_${chaosPrefix}_1`;
    const custAccount = repo.getCustomerAccountId(custId);
    const farePaise = 50000; // ₹500

    // Seed customer account
    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: farePaise, idempotencyKey: `TOP_${chaosPrefix}_1` });
    const initialBal = await repo.getCustomerBalance(custId);

    // Test Boundary A: Abort after acquiring advisory locks
    {
      const client = await pool.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`LOCK_BOUND_A_${Date.now()}`]);
        // Crash / Abort
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }

    // Test Boundary B: Abort after inserting uncommitted journal entry
    const abortedEntryId = `JE_CHAOS_B_${Date.now()}`;
    {
      const client = await pool.pool.connect();
      try {
        await client.query('BEGIN');
        const seqRes = await client.query("SELECT nextval('ledger_journal_entries_sequence_seq') as next_seq");
        await client.query(`
          INSERT INTO ledger_journal_entries (entry_id, sequence, reference_id, idempotency_key, description, total_paise, metadata, created_at)
          VALUES ($1, $2, 'CRASH_B', $3, 'Uncommitted Boundary B', 1000, '{}', NOW());
        `, [abortedEntryId, seqRes.rows[0].next_seq, `KEY_B_${Date.now()}`]);
        // Crash / Abort
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }

    // Verify 0 orphaned journal entries
    const checkEntry = await pool.query('SELECT * FROM ledger_journal_entries WHERE entry_id = $1', [abortedEntryId]);
    assert.strictEqual(checkEntry.rows.length, 0, 'Rolled-back journal entry must not persist');

    // Test Boundary C: Abort after inserting postings before balance update
    {
      const client = await pool.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          INSERT INTO ledger_postings (posting_id, entry_id, sequence, account_id, side, amount_paise, created_at)
          VALUES ($1, 'DUMMY_ENTRY', 1, $2, 'DEBIT', 500, NOW());
        `, [`POST_CHAOS_${Date.now()}`, custAccount]);
        // Crash / Abort
        await client.query('ROLLBACK');
      } catch (_) {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }

    // Test Boundary D: Abort after updating balances before inserting outbox event
    {
      const client = await pool.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE ledger_accounts SET balance_paise = balance_paise - 500 WHERE account_id = $1', [custAccount]);
        // Crash / Abort
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }

    // Customer balance must remain EXACTLY identical
    const finalBal = await repo.getCustomerBalance(custId);
    assert.strictEqual(finalBal.paise, initialBal.paise, 'Customer balance must remain completely untouched after transaction aborts');

    // Invariant check
    await assertLedgerInvariants(pool, repo);
  });

  // ===========================================================================
  // 2. POST-COMMIT PROCESS CRASH SIMULATION & IDEMPOTENT CONVERGENCE
  // ===========================================================================
  await t.test('2. Post-Commit Process Crash Simulation (Two-Phase Crash & Retry Convergence)', async () => {
    const tripId = `TRIP_${chaosPrefix}_2`;
    const custId = `CUST_${chaosPrefix}_2`;
    const farePaise = 25000; // ₹250
    const idempotencyKey = `IDEMP_CRASH_2_${Date.now()}`;

    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: farePaise, idempotencyKey: `TOP_${tripId}` });

    // Step 1: Initial reserveEscrow succeeds in database
    const firstRes = await integrationService.reserveEscrow({
      tripId,
      orderId: tripId,
      customerId: custId,
      amountPaise: farePaise,
      idempotencyKey
    });
    assert.strictEqual(firstRes.success, true);
    assert.strictEqual(firstRes.idempotentReplay, false);

    // Step 2: SIMULATE CRASH - Client timed out and retries with IDENTICAL idempotency key
    const replayRes = await integrationService.reserveEscrow({
      tripId,
      orderId: tripId,
      customerId: custId,
      amountPaise: farePaise,
      idempotencyKey
    });

    assert.strictEqual(replayRes.success, true);
    assert.strictEqual(replayRes.idempotentReplay, true, 'Subsequent retry must return idempotent replay');
    assert.strictEqual(replayRes.paymentId, firstRes.paymentId);
    assert.strictEqual(replayRes.version, firstRes.version);

    // Check exactly ONE transaction row exists in payment_transactions
    const txCheck = await pool.query('SELECT * FROM payment_transactions WHERE trip_id = $1', [tripId]);
    assert.strictEqual(txCheck.rows.length, 1, 'Exactly one payment transaction row must exist');

    await assertLedgerInvariants(pool, repo);
  });

  // ===========================================================================
  // 3. PROVIDER TIMEOUT / NETWORK PARTITION WITH REMOTE CAPTURE (MISSED WEBHOOK AUTO-HEALING)
  // ===========================================================================
  await t.test('3. Remote Provider Timeout with Captured Payment: Reconciler Auto-Heals and Converges', async () => {
    const tripId = `TRIP_${chaosPrefix}_3`;
    const paymentId = `PAY_${tripId}`;
    const custId = `CUST_${chaosPrefix}_3`;
    const orderId = `order_${chaosPrefix}_3`;
    const paymentRzpId = `pay_${chaosPrefix}_3`;
    const farePaise = 45000; // ₹450

    // 1. Initial mapping registered, but webhook was dropped by network partition!
    await ingestionService.registerPaymentMapping({
      provider: 'razorpay',
      providerOrderId: orderId,
      paymentId,
      tripId,
      customerId: custId,
      expectedAmountPaise: farePaise
    });

    await pool.query(`
      UPDATE payment_provider_mappings
      SET provider_payment_id = $1
      WHERE payment_id = $2;
    `, [paymentRzpId, paymentId]);

    // 2. Gateway confirms money was actually collected remotely
    const mockRemotePayments = new Map();
    mockRemotePayments.set(paymentRzpId, {
      providerPaymentId: paymentRzpId,
      providerOrderId: orderId,
      status: 'captured',
      amountPaise: farePaise,
      currency: 'INR',
      isCaptured: true
    });

    const mockProvider = {
      name: 'razorpay',
      fetchPayment: async (pid) => mockRemotePayments.get(pid)
    };

    const reconWorker = new ProviderReconciliationWorker({
      poolOrConfig: pool,
      providerAdapter: mockProvider,
      paymentIntegrationService: integrationService,
      autoHealMissingEscrow: true
    });

    // 3. Reconciler audits and auto-heals
    const cycle1 = await reconWorker.runReconciliationCycle({ limit: 5, paymentId });
    assert.strictEqual(cycle1.status, 'COMPLETED');
    assert.strictEqual(cycle1.autoResolvedCount, 1);

    // Verify transaction reached ESCROWED state with recovered funds
    const txCheck = await pool.query('SELECT state, escrow_paise FROM payment_transactions WHERE payment_id = $1', [paymentId]);
    assert.strictEqual(txCheck.rows[0].state, 'ESCROWED');
    assert.strictEqual(Number(txCheck.rows[0].escrow_paise), farePaise);

    // 4. Second reconciliation cycle immediately runs: 0 discrepancies, fully converged
    const cycle2 = await reconWorker.runReconciliationCycle({ limit: 5, paymentId });
    assert.strictEqual(cycle2.matchedCount, 1);
    assert.strictEqual(cycle2.discrepancyCount, 0);
    assert.strictEqual(cycle2.isBalanced, true);

    await assertLedgerInvariants(pool, repo);
  });

  // ===========================================================================
  // 4. WEBHOOK STORM: 30 SIMULTANEOUS DUPLICATE WEBHOOKS
  // ===========================================================================
  await t.test('4. Webhook Storm: 30 Simultaneous Duplicate Webhooks Yield Exactly 1 Financial Mutation', async () => {
    const tripId = `TRIP_${chaosPrefix}_4`;
    const paymentId = `PAY_${tripId}`;
    const custId = `CUST_${chaosPrefix}_4`;
    const orderRzpId = `order_storm_${Date.now()}`;
    const payRzpId = `pay_storm_${Date.now()}`;
    const farePaise = 38000;

    await ingestionService.registerPaymentMapping({
      provider: 'razorpay',
      providerOrderId: orderRzpId,
      paymentId,
      tripId,
      customerId: custId,
      expectedAmountPaise: farePaise
    });

    const eventId = `evt_storm_${Date.now()}`;
    const rawPayload = JSON.stringify({
      entity: 'event',
      account_id: 'acc_vaayu',
      event: 'payment.captured',
      event_id: eventId,
      payload: {
        payment: {
          entity: {
            id: payRzpId,
            order_id: orderRzpId,
            status: 'captured',
            amount: farePaise,
            currency: 'INR'
          }
        }
      }
    });

    const signature = crypto.createHmac('sha256', webhookSecret).update(rawPayload).digest('hex');

    // Fire 30 simultaneous webhooks for the exact same event
    const stormPromises = Array.from({ length: 30 }, () =>
      ingestionService.ingestWebhook({
        providerName: 'razorpay',
        rawBody: rawPayload,
        signature
      })
    );

    const stormResults = await Promise.all(stormPromises);

    // Exactly 1 must report initial success, 29 must report idempotent replay
    const initialCaptures = stormResults.filter(r => r.success && !r.idempotentReplay);
    const duplicates = stormResults.filter(r => r.idempotentReplay);

    assert.strictEqual(initialCaptures.length, 1, 'Exactly one webhook must execute the initial ledger mutation');
    assert.ok(stormResults.every(r => r.success === true), 'All duplicate webhook deliveries must converge successfully');
    assert.strictEqual(duplicates.length, 29, 'All 29 concurrent duplicates must be recognized without double debiting');

    // Exactly one journal entry for this escrow
    const jeCount = await pool.query('SELECT COUNT(*) FROM ledger_journal_entries WHERE reference_id = $1', [`TRIP_${tripId}_ESCROW`]);
    assert.strictEqual(Number(jeCount.rows[0].count), 1);

    await assertLedgerInvariants(pool, repo);
  });

  // ===========================================================================
  // 5. WEBHOOK INGESTION RACING CONCURRENTLY WITH RECONCILIATION WORKER
  // ===========================================================================
  await t.test('5. Webhook Ingestion Racing Concurrently with Reconciliation Worker', async () => {
    const tripId = `TRIP_${chaosPrefix}_5`;
    const paymentId = `PAY_${tripId}`;
    const custId = `CUST_${chaosPrefix}_5`;
    const orderRzpId = `order_race_${Date.now()}`;
    const payRzpId = `pay_race_${Date.now()}`;
    const farePaise = 52000;

    await ingestionService.registerPaymentMapping({
      provider: 'razorpay',
      providerOrderId: orderRzpId,
      paymentId,
      tripId,
      customerId: custId,
      expectedAmountPaise: farePaise
    });

    const mockProvider = {
      name: 'razorpay',
      fetchPayment: async () => ({
        providerPaymentId: payRzpId,
        providerOrderId: orderRzpId,
        status: 'captured',
        amountPaise: farePaise,
        currency: 'INR',
        isCaptured: true
      })
    };

    const reconWorker = new ProviderReconciliationWorker({
      poolOrConfig: pool,
      providerAdapter: mockProvider,
      paymentIntegrationService: integrationService,
      autoHealMissingEscrow: true
    });

    const rawPayload = JSON.stringify({
      entity: 'event',
      account_id: 'acc_vaayu',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: payRzpId,
            order_id: orderRzpId,
            status: 'captured',
            amount: farePaise,
            currency: 'INR'
          }
        }
      }
    });
    const signature = crypto.createHmac('sha256', webhookSecret).update(rawPayload).digest('hex');

    // Race webhook ingestion against reconciler cycle concurrently
    const [webhookRes, reconRes] = await Promise.all([
      ingestionService.ingestWebhook({ providerName: 'razorpay', rawBody: rawPayload, signature }),
      reconWorker.runReconciliationCycle({ limit: 5, paymentId })
    ]);

    assert.ok(webhookRes.success || reconRes.status === 'COMPLETED');

    // Exactly 1 escrow hold in payment_transactions
    const txRes = await pool.query('SELECT state, escrow_paise FROM payment_transactions WHERE payment_id = $1', [paymentId]);
    assert.strictEqual(txRes.rows.length, 1);
    assert.strictEqual(txRes.rows[0].state, 'ESCROWED');
    assert.strictEqual(Number(txRes.rows[0].escrow_paise), farePaise);

    await assertLedgerInvariants(pool, repo);
  });

  // ===========================================================================
  // 6. SETTLE VS EXPIRATION RACE ACROSS SEPARATE WORKERS
  // ===========================================================================
  await t.test('6. Settle vs Expiration Race Across Separate Workers: Zero Double Disbursement', async () => {
    const tripId = `TRIP_${chaosPrefix}_6`;
    const custId = `CUST_${chaosPrefix}_6`;
    const drvId = `DRV_${chaosPrefix}_6`;
    const farePaise = 30000;

    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: farePaise, idempotencyKey: `TOP_${tripId}` });
    await integrationService.reserveEscrow({ tripId, orderId: tripId, customerId: custId, amountPaise: farePaise });

    // Race settleTrip vs expirePayment concurrently
    const [settleResult, expireResult] = await Promise.allSettled([
      integrationService.settleTrip({ tripId, driverId: drvId, amountPaise: farePaise }),
      integrationService.expirePayment({ tripId, reason: 'Dispatch timed out' })
    ]);

    const isSettleSuccess = settleResult.status === 'fulfilled' && settleResult.value.success;
    const isExpireSuccess = expireResult.status === 'fulfilled' && expireResult.value.success;

    // Mutually exclusive: exactly one can succeed!
    assert.strictEqual(isSettleSuccess !== isExpireSuccess, true, 'Exactly one of settle or expire must win');

    const finalTx = await repo.getPayment(`PAY_${tripId}`);
    assert.ok(['SETTLED', 'EXPIRED'].includes(finalTx.state));

    await assertLedgerInvariants(pool, repo);
  });

  // ===========================================================================
  // 7. SETTLE VS FULL REFUND RACE ACROSS SEPARATE WORKERS
  // ===========================================================================
  await t.test('7. Settle vs Full Refund Race Across Separate Workers', async () => {
    const tripId = `TRIP_${chaosPrefix}_7`;
    const custId = `CUST_${chaosPrefix}_7`;
    const drvId = `DRV_${chaosPrefix}_7`;
    const farePaise = 40000;

    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: farePaise, idempotencyKey: `TOP_${tripId}` });
    await integrationService.reserveEscrow({ tripId, orderId: tripId, customerId: custId, amountPaise: farePaise });

    // Race settleTrip vs refundTrip concurrently
    const [settleResult, refundResult] = await Promise.allSettled([
      integrationService.settleTrip({ tripId, driverId: drvId, amountPaise: farePaise }),
      integrationService.refundTrip({ tripId, amountPaise: farePaise, reason: 'Customer refund' })
    ]);

    const isSettleSuccess = settleResult.status === 'fulfilled' && settleResult.value.success;
    const isRefundSuccess = refundResult.status === 'fulfilled' && refundResult.value.success;

    assert.strictEqual(isSettleSuccess !== isRefundSuccess, true, 'Exactly one of settle or refund must succeed');

    const finalTx = await repo.getPayment(`PAY_${tripId}`);
    assert.ok(['SETTLED', 'REFUNDED'].includes(finalTx.state));

    await assertLedgerInvariants(pool, repo);
  });

  // ===========================================================================
  // 8. TRANSACTIONAL OUTBOX WORKER CRASH & AT-LEAST-ONCE DELIVERY RESILIENCE
  // ===========================================================================
  await t.test('8. Transactional Outbox Worker Crash & At-Least-Once Delivery Resilience', async () => {
    const eventId = `EVT_CHAOS_OUTBOX_${Date.now()}`;
    const payload = { tripId: `TRIP_${chaosPrefix}_8`, amountPaise: 15000 };

    await pool.query(`
      INSERT INTO payment_outbox (event_id, aggregate_type, aggregate_id, event_type, payload, status, created_at)
      VALUES ($1, 'CHAOS_TEST_8', $2, 'PaymentEscrowed', $3, 'PENDING', NOW());
    `, [eventId, payload.tripId, JSON.stringify(payload)]);

    // Simulate Worker 1 crashing / failing during first dispatch attempt via customHandler
    let attempts = 0;
    const failingDispatcher = new OutboxDispatcher({
      poolOrConfig: pool,
      batchSize: 10,
      pollIntervalMs: 50,
      backoffBaseMs: 50,
      aggregateTypeFilter: 'CHAOS_TEST_8'
    });

    failingDispatcher.registerHandler('PaymentEscrowed', async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('Downstream network crash during outbox broadcast');
      }
      return true;
    });

    // Run cycle 1: Fails and triggers retry backoff
    await failingDispatcher.pollAndDispatch();

    const checkAttempt1 = await pool.query('SELECT attempt_count, status FROM payment_outbox WHERE event_id = $1', [eventId]);
    assert.strictEqual(checkAttempt1.rows[0].attempt_count, 1);
    assert.strictEqual(checkAttempt1.rows[0].status, 'PENDING');

    // Force next attempt to be eligible immediately
    await pool.query('UPDATE payment_outbox SET next_attempt_at = NOW() - INTERVAL \'1 second\' WHERE event_id = $1', [eventId]);

    // Run cycle 2: Worker restarts / recovers and delivers event
    await failingDispatcher.pollAndDispatch();

    const checkAttempt2 = await pool.query('SELECT status, published_at FROM payment_outbox WHERE event_id = $1', [eventId]);
    assert.strictEqual(checkAttempt2.rows[0].status, 'PUBLISHED');
    assert.ok(checkAttempt2.rows[0].published_at !== null);

    await assertLedgerInvariants(pool, repo);
  });

  // ===========================================================================
  // 9. DEADLOCK TORTURE UNDER EXTREME MULTI-ACCOUNT TRANSFERS
  // ===========================================================================
  await t.test('9. Deadlock Torture under Extreme Cross-Account Chaos Load (Zero 40P01 Deadlocks)', async () => {
    const accA = `acc:chaos:${chaosPrefix}:A`;
    const accB = `acc:chaos:${chaosPrefix}:B`;
    const accC = `acc:chaos:${chaosPrefix}:C`;

    await repo.ensureAccount(accA, 'LIABILITY', 'CREDIT');
    await repo.ensureAccount(accB, 'LIABILITY', 'CREDIT');
    await repo.ensureAccount(accC, 'LIABILITY', 'CREDIT');

    // Seed all 3 accounts
    for (const [acc, amt] of [[accA, 100000], [accB, 100000], [accC, 100000]]) {
      await repo.postJournalEntry({
        referenceId: `SEED_${acc}`,
        idempotencyKey: `SEED_${acc}`,
        description: 'Seed account',
        postings: [{ accountId: 'cash:external', side: 'DEBIT', amountPaise: amt }, { accountId: acc, side: 'CREDIT', amountPaise: amt }]
      });
    }

    // Launch 30 concurrent transfer pairs in deliberately reversed account order:
    // Pair 1: A -> B vs B -> A
    // Pair 2: B -> C vs C -> B
    // Pair 3: C -> A vs A -> C
    const transferPromises = [];
    for (let i = 0; i < 15; i++) {
      transferPromises.push(
        repo.postJournalEntry({
          referenceId: `TRANSFER_AB_${i}`,
          idempotencyKey: `KEY_AB_${chaosPrefix}_${i}`,
          description: `Transfer A to B ${i}`,
          postings: [{ accountId: accA, side: 'DEBIT', amountPaise: 100 }, { accountId: accB, side: 'CREDIT', amountPaise: 100 }]
        }),
        repo.postJournalEntry({
          referenceId: `TRANSFER_BA_${i}`,
          idempotencyKey: `KEY_BA_${chaosPrefix}_${i}`,
          description: `Transfer B to A ${i}`,
          postings: [{ accountId: accB, side: 'DEBIT', amountPaise: 100 }, { accountId: accA, side: 'CREDIT', amountPaise: 100 }]
        }),
        repo.postJournalEntry({
          referenceId: `TRANSFER_BC_${i}`,
          idempotencyKey: `KEY_BC_${chaosPrefix}_${i}`,
          description: `Transfer B to C ${i}`,
          postings: [{ accountId: accB, side: 'DEBIT', amountPaise: 100 }, { accountId: accC, side: 'CREDIT', amountPaise: 100 }]
        }),
        repo.postJournalEntry({
          referenceId: `TRANSFER_CA_${i}`,
          idempotencyKey: `KEY_CA_${chaosPrefix}_${i}`,
          description: `Transfer C to A ${i}`,
          postings: [{ accountId: accC, side: 'DEBIT', amountPaise: 100 }, { accountId: accA, side: 'CREDIT', amountPaise: 100 }]
        })
      );
    }

    // Must resolve all 60 concurrent cross-account transfers without a single PostgreSQL deadlock (40P01)
    const transferResults = await Promise.all(transferPromises);
    assert.strictEqual(transferResults.length, 60);

    await assertLedgerInvariants(pool, repo);
  });

  // ===========================================================================
  // 10. POSTGRESQL CONNECTION SEVERANCE & AUTOMATIC RETRY RECOVERY
  // ===========================================================================
  await t.test('10. PostgreSQL Connection Severance & Automatic Retry Recovery', async () => {
    const custId = `CUST_${chaosPrefix}_10`;
    const tripId = `TRIP_${chaosPrefix}_10`;
    const farePaise = 32000;
    const retryKey = `RETRY_SEVER_${chaosPrefix}_10`;

    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: farePaise, idempotencyKey: `TOP_${tripId}` });

    // Step 1: Open dedicated client, register error handler, and sever connection mid-query
    const directClient = await pool.pool.connect();
    directClient.on('error', () => {
      // Expected: cleanly capture injected socket severance
    });

    let abortedWithError = false;

    try {
      await directClient.query('BEGIN');
      await directClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [retryKey]);

      // Abruptly sever the network socket stream
      if (directClient.connection && directClient.connection.stream) {
        directClient.connection.stream.destroy(new Error('Connection unexpectedly dropped by chaos injector'));
      }

      await directClient.query('SELECT 1');
    } catch (netErr) {
      abortedWithError = true;
    } finally {
      try { directClient.release(true); } catch (_) {}
    }

    assert.strictEqual(abortedWithError, true, 'Socket severance must produce connection error');

    // Step 2: Client reconnects via fresh pool client and retries with same idempotency key
    const recoverRes = await integrationService.reserveEscrow({
      tripId,
      orderId: tripId,
      customerId: custId,
      amountPaise: farePaise,
      idempotencyKey: retryKey
    });

    assert.strictEqual(recoverRes.success, true);
    assert.strictEqual(recoverRes.state, 'ESCROWED');

    // Final authoritative system reconciliation
    await assertLedgerInvariants(pool, repo);

    // Final report from FinancialSecurityService confirms ₹0 imbalance across entire cluster
    const report = await securityService.generateForensicReport();
    assert.strictEqual(report.isDoubleEntryBalanced, true);
    assert.strictEqual(report.ledger.imbalancePaise, 0);
  });
});
