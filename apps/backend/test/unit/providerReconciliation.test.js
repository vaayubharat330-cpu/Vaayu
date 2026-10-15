'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const { PaymentIngestionService } = require('../../src/services/ledger/paymentIngestionService');
const { ProviderReconciliationWorker, DISCREPANCY_TYPES } = require('../../src/services/ledger/providerReconciliationWorker');
const { runMigrations } = require('../../src/db/runLedgerMigrations');

test('VAAYU Phase F.5: Automated Provider Reconciliation Worker Acceptance Suite', async (t) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip('Skipping F.5 provider reconciliation tests: DATABASE_ADMIN_URL not configured.');
    return;
  }

  await runMigrations();

  const pool = new PostgresPool({ connectionString, max: 20, connectionTimeoutMillis: 15000 });
  const repo = new PostgresLedgerRepository(pool);
  const psm = new PaymentStateMachine({ ledgerService: repo });
  const integrationService = new PaymentIntegrationService({ paymentStateMachine: psm });
  const ingestionService = new PaymentIngestionService({
    poolOrConfig: pool,
    paymentIntegrationService: integrationService
  });

  // Mock Provider Adapter simulating remote gateway responses
  const mockRemotePayments = new Map();
  const mockProvider = {
    name: 'razorpay',
    fetchPayment: async (paymentId) => {
      const found = mockRemotePayments.get(paymentId);
      if (!found) {
        const err = new Error(`Payment ${paymentId} not found at provider`);
        err.status = 404;
        throw err;
      }
      return found;
    }
  };

  const reconWorker = new ProviderReconciliationWorker({
    poolOrConfig: pool,
    providerAdapter: mockProvider,
    paymentIntegrationService: integrationService,
    batchSize: 50,
    pollIntervalMs: 100,
    autoHealMissingEscrow: true
  });

  t.after(async () => {
    await reconWorker.stop();
    await pool.end();
  });

  await t.test('1. Clean In-Sync Pass: All Matched Records Yield Balanced Status', async () => {
    const tripId = `TRIP_F5_SYNC_${Date.now()}`;
    const paymentId = `PAY_${tripId}`;
    const customerId = `CUST_F5_${Date.now()}`;
    const orderId = `order_sync_${Date.now()}`;
    const paymentRzpId = `pay_sync_${Date.now()}`;
    const farePaise = 35000;

    // Register mapping & pre-fund + escrow internal state
    await ingestionService.registerPaymentMapping({
      provider: 'razorpay',
      providerOrderId: orderId,
      paymentId,
      tripId,
      customerId,
      expectedAmountPaise: farePaise
    });

    await pool.query(`
      UPDATE payment_provider_mappings
      SET provider_payment_id = $1, status = 'CAPTURED'
      WHERE payment_id = $2;
    `, [paymentRzpId, paymentId]);

    await repo.topUpCustomerWallet({ customerId, amountPaise: farePaise, idempotencyKey: `TOP_${paymentId}` });
    await repo.reserveEscrow({ tripId, customerId, amountPaise: farePaise, idempotencyKey: `ESC_${paymentId}` });

    // Mock remote provider reports identical captured state
    mockRemotePayments.set(paymentRzpId, {
      providerPaymentId: paymentRzpId,
      providerOrderId: orderId,
      status: 'captured',
      amountPaise: farePaise,
      currency: 'INR',
      isCaptured: true
    });

    const result = await reconWorker.runReconciliationCycle({ limit: 10, paymentId });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.totalChecked, 1);
    assert.equal(result.matchedCount, 1);
    assert.equal(result.isBalanced, true);
  });

  await t.test('2. Missed Webhook Detection & Auto-Healing: Recovers Missing Escrow Hold', async () => {
    const tripId = `TRIP_F5_MISSED_WH_${Date.now()}`;
    const paymentId = `PAY_${tripId}`;
    const customerId = `CUST_F5_${Date.now()}`;
    const orderId = `order_missed_${Date.now()}`;
    const paymentRzpId = `pay_missed_${Date.now()}`;
    const farePaise = 42000; // ₹420.00

    // Mapping was registered before customer paid, but webhook was dropped by network!
    await ingestionService.registerPaymentMapping({
      provider: 'razorpay',
      providerOrderId: orderId,
      paymentId,
      tripId,
      customerId,
      expectedAmountPaise: farePaise
    });

    await pool.query(`
      UPDATE payment_provider_mappings
      SET provider_payment_id = $1
      WHERE payment_id = $2;
    `, [paymentRzpId, paymentId]);

    // Provider confirms money was actually collected/captured!
    mockRemotePayments.set(paymentRzpId, {
      providerPaymentId: paymentRzpId,
      providerOrderId: orderId,
      status: 'captured',
      amountPaise: farePaise,
      currency: 'INR',
      isCaptured: true
    });

    // Run reconciliation cycle
    const reconRes = await reconWorker.runReconciliationCycle({ limit: 10, paymentId });
    assert.equal(reconRes.status, 'COMPLETED');
    assert.ok(reconRes.autoResolvedCount >= 1, 'Missing escrow should be automatically resolved');

    // Verify discrepancy record was logged with AUTO_RESOLVED
    const discCheck = await pool.query(`
      SELECT discrepancy_type, resolution_status, resolution_action
      FROM payment_discrepancy_records
      WHERE payment_id = $1;
    `, [paymentId]);

    assert.equal(discCheck.rows.length, 1);
    assert.equal(discCheck.rows[0].discrepancy_type, DISCREPANCY_TYPES.MISSING_INTERNAL_ESCROW);
    assert.equal(discCheck.rows[0].resolution_status, 'AUTO_RESOLVED');
    assert.equal(discCheck.rows[0].resolution_action, 'AUTO_HEALED_ESCROW');

    // Verify internal PostgreSQL ledger now has the recovered escrow hold
    const paymentCheck = await pool.query('SELECT state, escrow_paise FROM payment_transactions WHERE payment_id = $1', [paymentId]);
    assert.equal(paymentCheck.rows[0].state, 'ESCROWED');
    assert.equal(Number(paymentCheck.rows[0].escrow_paise), farePaise);
  });

  await t.test('3. False Internal Settlement: Flags Severe Discrepancy for Manual Review', async () => {
    const tripId = `TRIP_F5_FALSE_SETTLE_${Date.now()}`;
    const paymentId = `PAY_${tripId}`;
    const customerId = `CUST_F5_${Date.now()}`;
    const orderId = `order_false_${Date.now()}`;
    const paymentRzpId = `pay_false_${Date.now()}`;
    const farePaise = 50000;

    await ingestionService.registerPaymentMapping({
      provider: 'razorpay',
      providerOrderId: orderId,
      paymentId,
      tripId,
      customerId,
      expectedAmountPaise: farePaise
    });

    await pool.query(`
      UPDATE payment_provider_mappings
      SET provider_payment_id = $1, status = 'CAPTURED'
      WHERE payment_id = $2;
    `, [paymentRzpId, paymentId]);

    // VAAYU ledger already has escrow
    await repo.topUpCustomerWallet({ customerId, amountPaise: farePaise, idempotencyKey: `TOP_${paymentId}` });
    await repo.reserveEscrow({ tripId, customerId, amountPaise: farePaise, idempotencyKey: `ESC_${paymentId}` });

    // Remote provider reports payment FAILED!
    mockRemotePayments.set(paymentRzpId, {
      providerPaymentId: paymentRzpId,
      providerOrderId: orderId,
      status: 'failed',
      amountPaise: farePaise,
      currency: 'INR',
      isCaptured: false
    });

    const reconRes = await reconWorker.runReconciliationCycle({ limit: 10, paymentId });
    assert.ok(reconRes.manualReviewCount >= 1);

    const discCheck = await pool.query(`
      SELECT discrepancy_type, resolution_status
      FROM payment_discrepancy_records
      WHERE payment_id = $1;
    `, [paymentId]);

    assert.equal(discCheck.rows[0].discrepancy_type, DISCREPANCY_TYPES.FALSE_INTERNAL_SETTLEMENT);
    assert.equal(discCheck.rows[0].resolution_status, 'OPEN');
  });

  await t.test('4. Amount Mismatch Detection: Flags Discrepancy Without Auto-Mutating Ledger', async () => {
    const tripId = `TRIP_F5_AMOUNT_MISMATCH_${Date.now()}`;
    const paymentId = `PAY_${tripId}`;
    const customerId = `CUST_F5_${Date.now()}`;
    const orderId = `order_amt_${Date.now()}`;
    const paymentRzpId = `pay_amt_${Date.now()}`;
    const expectedPaise = 60000;

    await ingestionService.registerPaymentMapping({
      provider: 'razorpay',
      providerOrderId: orderId,
      paymentId,
      tripId,
      customerId,
      expectedAmountPaise: expectedPaise
    });

    await pool.query(`
      UPDATE payment_provider_mappings
      SET provider_payment_id = $1, status = 'CAPTURED'
      WHERE payment_id = $2;
    `, [paymentRzpId, paymentId]);

    // Remote provider reports ₹400 instead of ₹600
    mockRemotePayments.set(paymentRzpId, {
      providerPaymentId: paymentRzpId,
      providerOrderId: orderId,
      status: 'captured',
      amountPaise: 40000,
      currency: 'INR',
      isCaptured: true
    });

    const reconRes = await reconWorker.runReconciliationCycle({ limit: 10, paymentId });
    assert.ok(reconRes.manualReviewCount >= 1);

    const discCheck = await pool.query(`
      SELECT discrepancy_type, provider_amount_paise, internal_amount_paise
      FROM payment_discrepancy_records
      WHERE payment_id = $1;
    `, [paymentId]);

    assert.equal(discCheck.rows[0].discrepancy_type, DISCREPANCY_TYPES.AMOUNT_MISMATCH);
    assert.equal(Number(discCheck.rows[0].provider_amount_paise), 40000);
    assert.equal(Number(discCheck.rows[0].internal_amount_paise), expectedPaise);
  });

  await t.test('5. Admin Operational Controls: Query & Manually Resolve Discrepancies', async () => {
    const openDiscrepancies = await reconWorker.getDiscrepancies({ status: 'OPEN' });
    assert.ok(openDiscrepancies.length >= 1);

    const target = openDiscrepancies[0];
    const resolved = await reconWorker.resolveDiscrepancyManually(target.discrepancyId, {
      action: 'OPERATOR_DISMISSED',
      notes: 'Investigated by ops; payment refunded on gateway.'
    });

    assert.ok(resolved);
    assert.equal(resolved.resolution_status, 'RESOLVED_MANUAL');
    assert.equal(resolved.resolution_action, 'OPERATOR_DISMISSED');
  });

  await t.test('6. Reconciliation Worker Start and Stop Lifecycle', async () => {
    const lifecycleWorker = new ProviderReconciliationWorker({
      poolOrConfig: pool,
      providerAdapter: mockProvider,
      pollIntervalMs: 50000 // Large interval so it does not fire during start/stop test
    });

    lifecycleWorker.isRunning = true;
    assert.equal(lifecycleWorker.isRunning, true);

    await lifecycleWorker.stop();
    assert.equal(lifecycleWorker.isRunning, false);
  });
});
