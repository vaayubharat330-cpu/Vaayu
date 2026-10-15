'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaymentStateMachine, PaymentStateError } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');
const { PaymentIntegrationService, ERROR_CODES } = require('../../src/services/ledger/paymentIntegrationService');

function createTestContext(commissionConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-step34-test-'));
  const repo = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository: repo });
  const psm = new PaymentStateMachine({ ledgerService: ledger, commissionConfig });
  const integration = new PaymentIntegrationService({ paymentStateMachine: psm });
  return { dir, repo, ledger, psm, integration };
}

test('VAAYU Step 3 & 4 Acceptance Suite', async (t) => {

  await t.test('1. Pre-settlement Partial Refunds & Fare Adjustments Invariants', async () => {
    const { psm, ledger, dir } = createTestContext();
    try {
      await psm.topUpCustomerWallet({ customerId: 'cust_refund', amountPaise: 100000 });
      await psm.reserveEscrow({ tripId: 'TRIP_PRE_REFUND', customerId: 'cust_refund', amountPaise: 50000 });

      // Partial refund 1: ₹50 (5,000 paise)
      const ref1 = await psm.refundTrip({
        tripId: 'TRIP_PRE_REFUND',
        amountPaise: 5000,
        reason: 'Promo code applied late',
        idempotencyKey: 'VAAYU:TRIP_PRE_REFUND:REFUND:001'
      });
      assert.equal(ref1.status, 'ESCROWED');
      assert.equal(ref1.isPartial, true);
      assert.equal(ref1.refundedPaise, 5000);
      assert.equal(ref1.totalRefundedPaise, 5000);
      assert.equal(ref1.remainingEscrowPaise, 45000);
      assert.equal(psm.getBalance('escrow:platform'), 45000);
      assert.equal(psm.getCustomerBalance('cust_refund').paise, 55000);

      // Partial refund 2: ₹100 (10,000 paise)
      const ref2 = await psm.refundTrip({
        tripId: 'TRIP_PRE_REFUND',
        amountPaise: 10000,
        reason: 'Route shortening adjustment',
        idempotencyKey: 'VAAYU:TRIP_PRE_REFUND:REFUND:002'
      });
      assert.equal(ref2.status, 'ESCROWED');
      assert.equal(ref2.isPartial, true);
      assert.equal(ref2.refundedPaise, 10000);
      assert.equal(ref2.totalRefundedPaise, 15000);
      assert.equal(ref2.remainingEscrowPaise, 35000);
      assert.equal(psm.getBalance('escrow:platform'), 35000);

      // Invariant check: refund > remaining escrow must REJECT with REFUND_LIMIT_EXCEEDED
      await assert.rejects(
        () => psm.refundTrip({
          tripId: 'TRIP_PRE_REFUND',
          amountPaise: 36000, // Only 35,000 remains in escrow!
          reason: 'Excessive refund'
        }),
        (err) => {
          assert.equal(err.code, 'REFUND_LIMIT_EXCEEDED');
          return true;
        }
      );

      // Refund exactly remaining escrow: ₹350 (35,000 paise) -> transitions to REFUNDED
      const ref3 = await psm.refundTrip({
        tripId: 'TRIP_PRE_REFUND',
        amountPaise: 35000,
        reason: 'Cancellation of remaining route',
        idempotencyKey: 'VAAYU:TRIP_PRE_REFUND:REFUND:003'
      });
      assert.equal(ref3.status, 'REFUNDED');
      assert.equal(ref3.isPartial, false);
      assert.equal(ref3.remainingEscrowPaise, 0);
      assert.equal(ref3.totalRefundedPaise, 50000);
      assert.equal(psm.getBalance('escrow:platform'), 0);
      assert.equal(psm.getCustomerBalance('cust_refund').paise, 100000);

      const audit = ledger.reconcile();
      assert.equal(audit.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('2. Escrow Expiration: Idempotency and Illegal Transition Guards', async () => {
    const { psm, ledger, dir } = createTestContext();
    try {
      await psm.topUpCustomerWallet({ customerId: 'cust_exp', amountPaise: 60000 });
      await psm.reserveEscrow({ tripId: 'TRIP_EXP_1', customerId: 'cust_exp', amountPaise: 40000 });

      // Expire abandoned escrow
      const exp1 = await psm.expirePayment({
        tripId: 'TRIP_EXP_1',
        reason: 'No driver accepted within 5 minutes',
        idempotencyKey: 'VAAYU:TRIP_EXP_1:EXPIRY'
      });
      assert.equal(exp1.status, 'EXPIRED');
      assert.equal(exp1.releasedPaise, 40000);
      assert.equal(psm.getCustomerBalance('cust_exp').paise, 60000);
      assert.equal(psm.getBalance('escrow:platform'), 0);

      // Duplicate expiry (idempotent replay)
      const exp2 = await psm.expirePayment({
        tripId: 'TRIP_EXP_1',
        reason: 'No driver accepted within 5 minutes',
        idempotencyKey: 'VAAYU:TRIP_EXP_1:EXPIRY'
      });
      assert.equal(exp2.status, 'EXPIRED');
      assert.equal(exp2.idempotentReplay, true);
      assert.equal(exp2.releasedPaise, 0); // No double credit

      // Expiry after settlement must REJECT
      await psm.reserveEscrow({ tripId: 'TRIP_SETTLE_THEN_EXP', customerId: 'cust_exp', amountPaise: 20000 });
      await psm.settleTrip({ tripId: 'TRIP_SETTLE_THEN_EXP', driverId: 'drv_exp', amountPaise: 20000 });

      await assert.rejects(
        () => psm.expirePayment({ tripId: 'TRIP_SETTLE_THEN_EXP' }),
        (err) => {
          assert.equal(err.code, 'ILLEGAL_PAYMENT_TRANSITION');
          return true;
        }
      );

      const audit = ledger.reconcile();
      assert.equal(audit.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('3. Post-Settlement Dispute & Strict Allocation-Verified Adjustment', async () => {
    const { psm, ledger, dir } = createTestContext({ commissionBps: 1000, gstBps: 1800 });
    try {
      await psm.topUpCustomerWallet({ customerId: 'c_disp', amountPaise: 50000 });
      await psm.reserveEscrow({ tripId: 'TRIP_DISPUTE_1', customerId: 'c_disp', amountPaise: 50000 });
      const settle = await psm.settleTrip({ tripId: 'TRIP_DISPUTE_1', driverId: 'd_disp', amountPaise: 50000 });

      // Verification of initial settlement: 50000 = 44100 + 5000 + 900
      assert.equal(settle.driverEarningsPaise, 44100);
      assert.equal(settle.commissionPaise, 5000);
      assert.equal(settle.gstPaise, 900);

      // Transition SETTLED -> DISPUTED
      const dispute = await psm.disputePayment({
        tripId: 'TRIP_DISPUTE_1',
        disputeId: 'DISP_001',
        reason: 'Customer reported delayed perishable cargo'
      });
      assert.equal(dispute.status, 'DISPUTED');

      // Allocation Mismatch rejection: customerCredit (10,000) != 7,000 + 2,000 + 0 (9,000)
      await assert.rejects(
        () => psm.adjustPayment({
          tripId: 'TRIP_DISPUTE_1',
          disputeId: 'DISP_001',
          allocations: {
            customerCreditPaise: 10000,
            driverDebitPaise: 7000,
            platformDebitPaise: 2000,
            taxAdjustmentPaise: 0 // Sum is 9,000 != 10,000
          }
        }),
        (err) => {
          assert.equal(err.code, 'INVALID_ADJUSTMENT_ALLOCATION');
          return true;
        }
      );

      // Driver clawback exceeds driver earnings rejection
      await assert.rejects(
        () => psm.adjustPayment({
          tripId: 'TRIP_DISPUTE_1',
          disputeId: 'DISP_001',
          allocations: {
            customerCreditPaise: 50000,
            driverDebitPaise: 45000, // Exceeds driver earnings 44,100!
            platformDebitPaise: 4000,
            taxAdjustmentPaise: 1000
          }
        }),
        (err) => {
          assert.equal(err.code, 'ADJUSTMENT_EXCEEDS_EARNINGS');
          return true;
        }
      );

      // Valid Adjustment: ₹100 dispute resolution
      // Customer gets ₹100 (10,000 paise).
      // Funded: Driver ₹80 (8,000 paise), Platform ₹16.95 (1,695 paise), Tax ₹3.05 (305 paise)
      const adj = await psm.adjustPayment({
        tripId: 'TRIP_DISPUTE_1',
        disputeId: 'DISP_001',
        allocations: {
          customerCreditPaise: 10000,
          driverDebitPaise: 8000,
          platformDebitPaise: 1695,
          taxAdjustmentPaise: 305
        },
        reason: 'Mutual 50% delay concession agreed'
      });

      assert.equal(adj.status, 'ADJUSTED');
      assert.equal(adj.adjustmentPaise, 10000);
      assert.equal(psm.getCustomerBalance('c_disp').paise, 10000);
      assert.equal(psm.getDriverBalance('d_disp').paise, 36100); // 44,100 - 8,000 = 36,100
      assert.equal(psm.getBalance('platform:commission'), 3305); // 5,000 - 1,695 = 3,305
      assert.equal(psm.getBalance('platform:gst'), 595); // 900 - 305 = 595

      // Duplicate adjustment replay returns cached result
      const replayAdj = await psm.adjustPayment({
        tripId: 'TRIP_DISPUTE_1',
        disputeId: 'DISP_001',
        allocations: {
          customerCreditPaise: 10000,
          driverDebitPaise: 8000,
          platformDebitPaise: 1695,
          taxAdjustmentPaise: 305
        }
      });
      assert.equal(replayAdj.idempotentReplay, true);

      // Verify original settlement journal remains intact (never deleted/mutated)
      const audit = ledger.reconcile();
      assert.equal(audit.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('4. Concurrency Races: 10 Concurrent Partial Refunds', async () => {
    const { psm, ledger, dir } = createTestContext();
    try {
      await psm.topUpCustomerWallet({ customerId: 'c_race_ref', amountPaise: 100000 });
      await psm.reserveEscrow({ tripId: 'TRIP_RACE_REF', customerId: 'c_race_ref', amountPaise: 50000 });

      // Fire 10 concurrent refund attempts of ₹100 (10,000 paise) each.
      // Total attempted: ₹1,000 (100,000 paise), but escrow is only ₹500 (50,000 paise).
      // Exactly 5 should succeed, and 5 should be rejected with REFUND_LIMIT_EXCEEDED.
      const attempts = Array.from({ length: 10 }, (_, i) => {
        return psm.refundTrip({
          tripId: 'TRIP_RACE_REF',
          amountPaise: 10000,
          reason: `Concurrent partial refund attempt ${i}`,
          idempotencyKey: `VAAYU:TRIP_RACE_REF:REFUND_RACE_${i}`
        }).then(() => true).catch(() => false);
      });

      const results = await Promise.all(attempts);
      const successes = results.filter(r => r === true).length;
      const failures = results.filter(r => r === false).length;

      assert.equal(successes, 5);
      assert.equal(failures, 5);
      assert.equal(psm.getBalance('escrow:platform'), 0);
      assert.equal(psm.getCustomerBalance('c_race_ref').paise, 100000);

      const audit = ledger.reconcile();
      assert.equal(audit.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('5. Concurrency Race: Settlement vs Expiry Race', async () => {
    const { psm, ledger, dir } = createTestContext();
    try {
      await psm.topUpCustomerWallet({ customerId: 'c_race_se', amountPaise: 50000 });
      await psm.reserveEscrow({ tripId: 'TRIP_SE_RACE', customerId: 'c_race_se', amountPaise: 30000 });

      // Run settleTrip and expirePayment concurrently on the exact same trip
      const p1 = psm.settleTrip({ tripId: 'TRIP_SE_RACE', driverId: 'd_se_race', amountPaise: 30000 }).then(r => ({ op: 'settle', res: r })).catch(e => ({ op: 'settle', err: e }));
      const p2 = psm.expirePayment({ tripId: 'TRIP_SE_RACE' }).then(r => ({ op: 'expire', res: r })).catch(e => ({ op: 'expire', err: e }));

      const [r1, r2] = await Promise.all([p1, p2]);

      // Mutex serialization guarantees exactly ONE operation succeeds and the second fails with illegal transition
      const oneSucceeded = (r1.res && !r2.res) || (!r1.res && r2.res);
      assert.equal(oneSucceeded, true);

      // Ledger invariant: escrow is zero, perfectly balanced
      assert.equal(psm.getBalance('escrow:platform'), 0);
      const audit = ledger.reconcile();
      assert.equal(audit.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('6. Domain Events Emission Observability', async () => {
    const { psm, integration, dir } = createTestContext();
    try {
      const capturedEvents = [];
      psm.on('*', e => capturedEvents.push(e));

      await psm.topUpCustomerWallet({ customerId: 'c_evt', amountPaise: 80000 });
      await psm.reserveEscrow({ tripId: 'TRIP_EVT_1', customerId: 'c_evt', amountPaise: 40000 });
      await psm.refundTrip({ tripId: 'TRIP_EVT_1', amountPaise: 10000 });
      await psm.settleTrip({ tripId: 'TRIP_EVT_1', driverId: 'd_evt', amountPaise: 30000 });
      await psm.disputePayment({ tripId: 'TRIP_EVT_1', disputeId: 'DISP_EVT_1' });
      await psm.adjustPayment({
        tripId: 'TRIP_EVT_1',
        disputeId: 'DISP_EVT_1',
        allocations: {
          customerCreditPaise: 5000,
          driverDebitPaise: 4000,
          platformDebitPaise: 847,
          taxAdjustmentPaise: 153
        }
      });

      const eventTypes = capturedEvents.map(e => e.eventType);
      assert.ok(eventTypes.includes('PaymentEscrowed'));
      assert.ok(eventTypes.includes('PaymentPartiallyRefunded'));
      assert.ok(eventTypes.includes('PaymentSettled'));
      assert.ok(eventTypes.includes('PaymentDisputed'));
      assert.ok(eventTypes.includes('PaymentAdjusted'));

      // PaymentIntegrationService event log matches
      assert.equal(integration.events.length, capturedEvents.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('7. PaymentIntegrationService Normalized Machine-Readable Error Responses', async () => {
    const { integration, psm, dir } = createTestContext();
    try {
      // 1. Insufficient Wallet Balance
      const res1 = await integration.reserveEscrow({
        tripId: 'TRIP_INT_1',
        customerId: 'c_no_money',
        amountPaise: 50000
      });
      assert.equal(res1.success, false);
      assert.equal(res1.error.code, ERROR_CODES.INSUFFICIENT_WALLET_BALANCE);

      // 2. Illegal State Transition
      await psm.topUpCustomerWallet({ customerId: 'c_int_ok', amountPaise: 50000 });
      await integration.reserveEscrow({ tripId: 'TRIP_INT_2', customerId: 'c_int_ok', amountPaise: 30000 });
      await integration.settleTrip({ tripId: 'TRIP_INT_2', driverId: 'd_int_ok' });

      // Try refunding settled trip -> Illegal transition
      const res2 = await integration.refundTrip({ tripId: 'TRIP_INT_2', amountPaise: 10000 });
      assert.equal(res2.success, false);
      assert.equal(res2.error.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION);

      // 3. Payment not found
      const res3 = await integration.refundTrip({ tripId: 'TRIP_DOES_NOT_EXIST' });
      assert.equal(res3.success, false);
      assert.equal(res3.error.code, ERROR_CODES.PAYMENT_NOT_FOUND);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
