'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaymentStateMachine, PaymentStateError } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');

function createFreshPsm(commissionConfig = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-psm-test-'));
  const repo = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository: repo });
  const psm = new PaymentStateMachine({ ledgerService: ledger, commissionConfig });
  return { psm, ledger, dir };
}

describe('VAAYU Payment State Machine (Step 1 + Step 2)', () => {

  test('1. Legal State Transitions: INITIATED -> ESCROWED -> SETTLED', async () => {
    const { psm, ledger, dir } = createFreshPsm();
    try {
      await psm.topUpCustomerWallet({ customerId: 'c1', amountPaise: 50000 });

      // INITIATED -> ESCROWED
      const escrow = await psm.reserveEscrow({ tripId: 'TRIP_100', customerId: 'c1', amountPaise: 50000 });
      assert.equal(escrow.status, 'ESCROWED');
      assert.equal(escrow.version, 2);

      // ESCROWED -> SETTLED
      const settle = await psm.settleTrip({ tripId: 'TRIP_100', driverId: 'd1' });
      assert.equal(settle.status, 'SETTLED');
      assert.equal(settle.version, 3);

      const tx = psm.getPaymentByTripId('TRIP_100');
      assert.equal(tx.state, 'SETTLED');
      assert.equal(ledger.reconcile().ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('2. Legal State Transitions: ESCROWED -> REFUNDED and ESCROWED -> EXPIRED', async () => {
    const { psm, dir } = createFreshPsm();
    try {
      await psm.topUpCustomerWallet({ customerId: 'c2', amountPaise: 100000 });

      // Trip A: ESCROWED -> REFUNDED
      await psm.reserveEscrow({ tripId: 'TRIP_REFUND', customerId: 'c2', amountPaise: 40000 });
      const refund = await psm.refundTrip({ tripId: 'TRIP_REFUND', reason: 'Customer cancelled' });
      assert.equal(refund.status, 'REFUNDED');
      assert.equal(psm.getPaymentByTripId('TRIP_REFUND').state, 'REFUNDED');

      // Trip B: ESCROWED -> EXPIRED
      await psm.reserveEscrow({ tripId: 'TRIP_EXPIRE', customerId: 'c2', amountPaise: 30000 });
      const expire = await psm.expireEscrow({ tripId: 'TRIP_EXPIRE', reason: 'SLA timeout' });
      assert.equal(expire.status, 'EXPIRED');
      assert.equal(psm.getPaymentByTripId('TRIP_EXPIRE').state, 'EXPIRED');

      // Customer wallet balance restored: 1000 - 400 - 300 + 400 + 300 = ₹1,000
      assert.equal(psm.getCustomerBalance('c2').rupees, 1000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('3. Illegal Transition Rejections', async () => {
    const { psm, dir } = createFreshPsm();
    try {
      await psm.topUpCustomerWallet({ customerId: 'c3', amountPaise: 100000 });

      // Setup Trip Settle
      await psm.reserveEscrow({ tripId: 'TRIP_S', customerId: 'c3', amountPaise: 30000 });
      await psm.settleTrip({ tripId: 'TRIP_S', driverId: 'd3' });

      // A. SETTLED -> ESCROWED (Must REJECT)
      assert.throws(
        () => psm._transitionPayment({ paymentId: 'PAY_TRIP_S', expectedState: 'SETTLED', nextState: 'ESCROWED' }),
        err => err instanceof PaymentStateError && err.code === 'ILLEGAL_PAYMENT_TRANSITION'
      );

      // B. SETTLED -> REFUNDED directly without dispute (Must REJECT)
      await assert.rejects(
        () => psm.refundTrip({ tripId: 'TRIP_S' }),
        err => err instanceof PaymentStateError && err.code === 'ILLEGAL_PAYMENT_TRANSITION'
      );

      // Setup Trip Refund
      await psm.reserveEscrow({ tripId: 'TRIP_R', customerId: 'c3', amountPaise: 20000 });
      await psm.refundTrip({ tripId: 'TRIP_R' });

      // C. REFUNDED -> ESCROWED (Must REJECT)
      assert.throws(
        () => psm._transitionPayment({ paymentId: 'PAY_TRIP_R', nextState: 'ESCROWED' }),
        err => err instanceof PaymentStateError && err.code === 'ILLEGAL_PAYMENT_TRANSITION'
      );

      // D. REFUNDED -> SETTLED (Must REJECT)
      await assert.rejects(
        () => psm.settleTrip({ tripId: 'TRIP_R', driverId: 'd3' }),
        err => err instanceof PaymentStateError && err.code === 'ILLEGAL_PAYMENT_TRANSITION'
      );

      // Setup Trip Expire
      await psm.reserveEscrow({ tripId: 'TRIP_E', customerId: 'c3', amountPaise: 20000 });
      await psm.expireEscrow({ tripId: 'TRIP_E' });

      // E. EXPIRED -> ESCROWED (Must REJECT)
      assert.throws(
        () => psm._transitionPayment({ paymentId: 'PAY_TRIP_E', nextState: 'ESCROWED' }),
        err => err instanceof PaymentStateError && err.code === 'ILLEGAL_PAYMENT_TRANSITION'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('4. Cross-Trip Isolation: TRIP_B settlement cannot settle TRIP_A escrow', async () => {
    const { psm, dir } = createFreshPsm();
    try {
      await psm.topUpCustomerWallet({ customerId: 'c_iso', amountPaise: 100000 });

      // Trip A escrowed
      await psm.reserveEscrow({ tripId: 'TRIP_A', customerId: 'c_iso', amountPaise: 40000 });

      // Attempt to settle Trip B (which was never escrowed)
      await assert.rejects(
        () => psm.settleTrip({ tripId: 'TRIP_B', driverId: 'd_iso' }),
        err => err instanceof PaymentStateError && err.code === 'PAYMENT_NOT_FOUND'
      );

      // TRIP_A escrow remains intact
      assert.equal(psm.getPaymentByTripId('TRIP_A').state, 'ESCROWED');
      assert.equal(psm.getBalance('escrow:platform'), 40000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('5. Explicit Commission Split: ₹500 fare, 10% commission, 18% GST', async () => {
    const { psm, ledger, dir } = createFreshPsm({
      commissionBps: 1000, // 10.00%
      gstBps: 1800         // 18.00% on commission
    });
    try {
      await psm.topUpCustomerWallet({ customerId: 'c_split', amountPaise: 50000 });
      await psm.reserveEscrow({ tripId: 'TRIP_SPLIT', customerId: 'c_split', amountPaise: 50000 });

      const settle = await psm.settleTrip({ tripId: 'TRIP_SPLIT', driverId: 'd_split' });

      // Invariant: 50,000 = 44,100 + 5,000 + 900
      assert.equal(settle.totalFarePaise, 50000);
      assert.equal(settle.driverEarningsPaise, 44100); // ₹441.00
      assert.equal(settle.commissionPaise, 5000);      // ₹50.00
      assert.equal(settle.gstPaise, 900);             // ₹9.00
      assert.equal(settle.totalFarePaise, settle.driverEarningsPaise + settle.commissionPaise + settle.gstPaise);

      // Verify double-entry ledger account balances
      assert.equal(psm.getDriverBalance('d_split').paise, 44100);
      assert.equal(psm.getBalance('platform:commission'), 5000);
      assert.equal(psm.getBalance('platform:gst'), 900);
      assert.equal(psm.getBalance('escrow:platform'), 0);

      const audit = ledger.reconcile();
      assert.equal(audit.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('6. Concurrent Settlement: 4 simultaneous settleTrip calls', async () => {
    const { psm, ledger, dir } = createFreshPsm();
    try {
      await psm.topUpCustomerWallet({ customerId: 'c_conc', amountPaise: 40000 });
      await psm.reserveEscrow({ tripId: 'TRIP_CONC_1', customerId: 'c_conc', amountPaise: 40000 });

      // 4 simultaneous settlement commands
      const settlements = await Promise.all([
        psm.settleTrip({ tripId: 'TRIP_CONC_1', driverId: 'd_conc', idempotencyKey: 'VAAYU:TRIP_CONC_1:SETTLE' }),
        psm.settleTrip({ tripId: 'TRIP_CONC_1', driverId: 'd_conc', idempotencyKey: 'VAAYU:TRIP_CONC_1:SETTLE' }),
        psm.settleTrip({ tripId: 'TRIP_CONC_1', driverId: 'd_conc', idempotencyKey: 'VAAYU:TRIP_CONC_1:SETTLE' }),
        psm.settleTrip({ tripId: 'TRIP_CONC_1', driverId: 'd_conc', idempotencyKey: 'VAAYU:TRIP_CONC_1:SETTLE' }),
      ]);

      assert.equal(settlements.every(s => s.success), true);
      assert.equal(settlements.filter(s => s.idempotentReplay).length, 3); // 1 primary, 3 replays

      // Zero double settlements
      // 40,000 - 4,000 comm - 720 gst = 35,280 driver earnings
      assert.equal(psm.getDriverBalance('d_conc').paise, 35280);
      assert.equal(psm.getBalance('escrow:platform'), 0);

      const audit = ledger.reconcile();
      assert.equal(audit.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('7. Optimistic Concurrency Version Conflict', async () => {
    const { psm, dir } = createFreshPsm();
    try {
      await psm.topUpCustomerWallet({ customerId: 'c_ver', amountPaise: 50000 });
      const escrow = await psm.reserveEscrow({ tripId: 'TRIP_VER', customerId: 'c_ver', amountPaise: 50000 });
      const currentVersion = escrow.version; // version 2

      // Worker A attempts settlement with expectedVersion = 2 (SUCCESS)
      const resA = await psm.settleTrip({ tripId: 'TRIP_VER', driverId: 'd_ver', expectedVersion: currentVersion });
      assert.equal(resA.success, true);
      assert.equal(resA.version, 3);

      // Worker B attempts cancellation/refund with stale expectedVersion = 2 (REJECTED: VERSION_CONFLICT)
      await assert.rejects(
        () => psm.refundTrip({ tripId: 'TRIP_VER', expectedVersion: currentVersion }),
        err => err instanceof PaymentStateError && (err.code === 'VERSION_CONFLICT' || err.code === 'ILLEGAL_PAYMENT_TRANSITION')
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('8. Historical Commission Rate Snapshot', async () => {
    const { psm, dir } = createFreshPsm({ commissionBps: 1000, gstBps: 1800 });
    try {
      await psm.topUpCustomerWallet({ customerId: 'c_hist', amountPaise: 50000 });
      await psm.reserveEscrow({ tripId: 'TRIP_HIST', customerId: 'c_hist', amountPaise: 50000 });
      await psm.settleTrip({ tripId: 'TRIP_HIST', driverId: 'd_hist' });

      // Now platform changes global commission rate: 10% -> 15% (1500 bps)
      psm.commissionConfig.commissionBps = 1500;

      // Historical transaction snapshot must NOT recalculate
      const historicalTx = psm.getPaymentByTripId('TRIP_HIST');
      assert.equal(historicalTx.commissionBps, 1000);
      assert.equal(historicalTx.commissionPaise, 5000);
      assert.equal(historicalTx.driverEarningsPaise, 44100);
      assert.equal(psm.getDriverBalance('d_hist').paise, 44100);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
