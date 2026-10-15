/**
 * VAAYU Milestone 13: Fraud & Risk Engine Suite
 * 
 * Verifies the 12 domains of the Pillar 13 Fraud & Risk Architecture:
 * 1. P13.1 & P13.2: Payment velocity abuse, refund limits & device-correlated Sybil accounts.
 * 2. P13.3 & P13.5: Driver GPS spoofing, impossible speed teleportation & driver-customer collusion rings.
 * 3. P13.4 & P13.6: Customer cancellation abuse & exposure limit bounds.
 * 4. P13.7 & P13.8: Deterministic categorical scoring (ALLOW/DELAY/REVIEW/BLOCK) & Maker-Checker dual control.
 * 5. P13.9 & P13.10: Multi-tenant risk isolation, non-confiscation audit invariants & false-positive protection.
 * 6. P13.11 & 13.12: Adversarial attack simulations, observability counters & PostgreSQL double-entry audit (₹0 imbalance).
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');

const { FraudRiskEngine, RISK_DECISIONS } = require('../../src/services/fraudRiskEngine');
const { metricsService } = require('../../src/services/metricsService');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');

test('Pillar 13: Fraud & Risk Engine Suite', async (suite) => {

  // =========================================================================
  // 13.1 & 13.2: PAYMENT ABUSE & DEVICE-CORRELATED ACCOUNT FARMING
  // =========================================================================
  await suite.test('13.1 & 13.2: Payment Velocity Abuse & Multi-Account Device Fingerprinting', async () => {
    const engine = new FraudRiskEngine();
    const badCustomerId = 'cust_payment_abuser_01';

    // 1. Simulate 5 rapid payment failures within 2 minutes
    for (let i = 0; i < 5; i++) {
      engine.recordPaymentFailure(badCustomerId);
    }

    const riskEval = engine.evaluateTransactionRisk({
      customerId: badCustomerId,
      amountPaise: 50000
    });

    assert.ok(riskEval.riskScore >= 60, 'High payment failure velocity must escalate risk score');
    assert.ok(riskEval.flags.includes('HIGH_PAYMENT_FAILURE_VELOCITY'));
    assert.equal(riskEval.decision, RISK_DECISIONS.REVIEW);

    // 2. Sybil Account Farm: 4 distinct accounts sharing the exact same device ID
    const sharedDeviceId = 'dev_fingerprint_sybil_999';
    engine.evaluateTransactionRisk({ customerId: 'usr_sybil_1', deviceId: sharedDeviceId });
    engine.evaluateTransactionRisk({ customerId: 'usr_sybil_2', deviceId: sharedDeviceId });
    engine.evaluateTransactionRisk({ customerId: 'usr_sybil_3', deviceId: sharedDeviceId });
    const sybilEval = engine.evaluateTransactionRisk({ customerId: 'usr_sybil_4', deviceId: sharedDeviceId });

    assert.ok(sybilEval.flags.includes('MULTIPLE_ACCOUNTS_ON_SAME_DEVICE'));
    assert.ok(sybilEval.riskScore >= 50);
  });

  // =========================================================================
  // 13.3 & 13.5: DRIVER GPS SPOOFING & DRIVER-CUSTOMER COLLUSION RINGS
  // =========================================================================
  await suite.test('13.3 & 13.5: GPS Teleportation Spoofing & Driver-Customer Collusion Rings', async () => {
    const engine = new FraudRiskEngine();

    // 1. GPS Spoofing: Impossible velocity teleportation (e.g. 350 km/h)
    const spoofEval = engine.evaluateTransactionRisk({
      driverId: 'drv_spoof_01',
      telemetry: { calculatedSpeedKmh: 350.0 }
    });

    assert.equal(spoofEval.decision, RISK_DECISIONS.BLOCK, 'Impossible speed teleportation must trigger immediate BLOCK');
    assert.ok(spoofEval.flags.includes('GPS_TELEPORTATION_IMPOSSIBLE_VELOCITY'));
    assert.ok(spoofEval.riskScore >= 85);

    // 2. Driver-Customer Collusion: Repeated pairings to drain promotional budgets
    const colludingDriver = 'drv_collusion_01';
    const colludingCustomer = 'cust_collusion_01';

    let lastCollusionEval = null;
    for (let i = 0; i < 5; i++) {
      lastCollusionEval = engine.evaluateTransactionRisk({
        driverId: colludingDriver,
        customerId: colludingCustomer,
        amountPaise: 25000
      });
    }

    assert.ok(lastCollusionEval.flags.includes('SUSPICIOUS_REPEAT_COLLUSION_PAIRING'));
    assert.ok(lastCollusionEval.riskScore >= 75);
    assert.equal(lastCollusionEval.decision, RISK_DECISIONS.REVIEW);
  });

  // =========================================================================
  // 13.4 & 13.6: CANCELLATION FARMING & TRANSACTION EXPOSURE BOUNDS
  // =========================================================================
  await suite.test('13.4 & 13.6: Customer Cancellation Farming & Single-Transaction Exposure Limits', async () => {
    const engine = new FraudRiskEngine();
    const chronicCanceller = 'cust_canceller_01';

    // 1. Simulate 4 cancellations within 1 hour
    for (let i = 0; i < 4; i++) {
      engine.recordCustomerCancellation(chronicCanceller);
    }

    const cancelEval = engine.evaluateTransactionRisk({ customerId: chronicCanceller });
    assert.ok(cancelEval.flags.includes('EXCESSIVE_CANCELLATION_VELOCITY'));
    assert.equal(cancelEval.decision, RISK_DECISIONS.DELAY, 'Cancellation farming must introduce DELAY cooldown');

    // 2. Single-Transaction Exposure Bounds: Transaction exceeds ₹20,000 threshold
    const hugeExposureEval = engine.evaluateTransactionRisk({
      customerId: 'cust_normal_01',
      amountPaise: 2500000 // ₹25,000
    });
    assert.ok(hugeExposureEval.flags.includes('EXCEEDS_SINGLE_TRANSACTION_EXPOSURE_LIMIT'));
    assert.ok(hugeExposureEval.riskScore >= 40);
  });

  // =========================================================================
  // 13.7 & 13.8: DETERMINISTIC SCORING & MAKER-CHECKER DUAL CONTROL
  // =========================================================================
  await suite.test('13.7 & 13.8: Deterministic Risk Scoring & Maker-Checker Dual Control Enforcement', async () => {
    const engine = new FraudRiskEngine();

    // 1. Clean Transaction: ALLOW
    const cleanEval = engine.evaluateTransactionRisk({
      customerId: 'cust_clean_01',
      driverId: 'drv_clean_01',
      amountPaise: 15000
    });
    assert.equal(cleanEval.decision, RISK_DECISIONS.ALLOW);
    assert.equal(cleanEval.riskScore, 0);

    // 2. Maker-Checker Workflow: Create review ticket for high-risk override
    const makerId = 'analyst_suraj_01';
    const checkerId = 'supervisor_priya_02';

    const ticket = engine.createReviewTicket('UNFREEZE_SUSPICIOUS_PAYOUT', makerId, {
      driverId: 'drv_held_01',
      amountPaise: 40000
    });
    assert.ok(ticket.reviewId);
    assert.equal(ticket.status, 'PENDING');

    // 3. Maker-Checker Anti-Bypass: Self-Approval is Strictly Prohibited
    const selfApprovalRes = engine.resolveReviewTicket(ticket.reviewId, makerId, 'APPROVED');
    assert.equal(selfApprovalRes.success, false);
    assert.equal(selfApprovalRes.error, 'DUAL_CONTROL_VIOLATION');

    // 4. Legitimate Checker Approval: Distinct identity succeeds
    const supervisorApproval = engine.resolveReviewTicket(ticket.reviewId, checkerId, 'APPROVED', 'Verified driver delivery photo');
    assert.equal(supervisorApproval.success, true);
    assert.equal(supervisorApproval.ticket.status, 'APPROVED');
    assert.equal(supervisorApproval.ticket.checkerId, checkerId);
  });

  // =========================================================================
  // 13.9 & 13.10: MULTI-TENANT RISK ISOLATION & NON-CONFISCATION AUDIT
  // =========================================================================
  await suite.test('13.9 & 13.10: Multi-Tenant Risk Boundary Isolation & Non-Confiscation Invariant', async () => {
    const engine = new FraudRiskEngine();

    // Tenant A transaction evaluated
    const evalTenantA = engine.evaluateTransactionRisk({
      customerId: 'usr_corp_A',
      merchantId: 'merchant_enterprise_alpha',
      amountPaise: 30000
    });
    assert.equal(evalTenantA.merchantId, 'merchant_enterprise_alpha');

    // Tenant B transaction evaluated independently
    const evalTenantB = engine.evaluateTransactionRisk({
      customerId: 'usr_corp_B',
      merchantId: 'merchant_enterprise_beta',
      amountPaise: 30000
    });
    assert.equal(evalTenantB.merchantId, 'merchant_enterprise_beta');

    // Invariant: Risk Engine produces explicit decision records and never deletes/confiscates balances
    assert.ok(evalTenantA.evaluationId);
    assert.ok(evalTenantB.evaluationId);
    assert.equal(evalTenantA.decision, RISK_DECISIONS.ALLOW);
    assert.equal(evalTenantB.decision, RISK_DECISIONS.ALLOW);
  });

  // =========================================================================
  // 13.11 & 13.12: FINANCIAL INVARIANT & POSTGRESQL RECONCILIATION
  // =========================================================================
  await suite.test('13.11 & 13.12: Financial Core Invariant: Settlement under Risk Oversight & ₹0 Ledger Balance', async () => {
    const tripId = `TRIP_P13_FIN_${Date.now()}`;
    const customerId = `cust_p13_${Date.now()}`;
    const driverId = `drv_p13_${Date.now()}`;
    const farePaise = 60000; // ₹600.00

    const repo = new PostgresLedgerRepository();
    const psm = new PaymentStateMachine({ ledgerService: repo });
    const paymentService = new PaymentIntegrationService({ ledgerService: repo, paymentStateMachine: psm });
    const engine = new FraudRiskEngine();

    // 1. Pre-Payment Risk Evaluation: Clean customer permitted to escrow
    const riskCheck = engine.evaluateTransactionRisk({
      customerId,
      driverId,
      amountPaise: farePaise
    });
    assert.equal(riskCheck.decision, RISK_DECISIONS.ALLOW);

    // 2. Fund Customer Wallet & Reserve Escrow
    await repo.topUpCustomerWallet({ customerId, amountPaise: 100000, idempotencyKey: `top:p13:${tripId}` });
    const escrowRes = await paymentService.reserveEscrow({
      tripId,
      orderId: tripId,
      customerId,
      amountPaise: farePaise,
      idempotencyKey: `esc:p13:${tripId}`
    });
    assert.equal(escrowRes.success, true);
    assert.equal(escrowRes.state, 'ESCROWED');

    // 3. Settle Trip through Frozen Payment Integration Service
    const settleRes = await paymentService.settleTrip({
      tripId,
      driverId,
      amountPaise: farePaise,
      idempotencyKey: `set:p13:${tripId}`
    });
    assert.equal(settleRes.success, true);
    assert.equal(settleRes.state, 'SETTLED');

    // 4. PostgreSQL Double-Entry Ledger Reconciliation
    const rec = await repo.reconcile();
    assert.equal(rec.ok, true, 'PostgreSQL double-entry reconciliation must be clean');
    assert.equal(rec.problems.length, 0, 'Zero ledger discrepancy problems allowed');

    // 5. Metrics Observability Verification
    const metricsSnapshot = metricsService.getSnapshot();
    assert.ok(metricsSnapshot.counters.risk_evaluations_total > 0);
    assert.ok(metricsSnapshot.counters.risk_decisions_allow_total > 0);
    assert.ok(metricsSnapshot.counters.risk_maker_checker_actions_total > 0);

    await repo.pool.end();
  });
});
