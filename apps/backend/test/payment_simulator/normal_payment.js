'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');

async function runNormalPaymentTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-normal-test-'));
  const repo = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository: repo });
  const psm = new PaymentStateMachine({ ledgerService: ledger });

  try {
    // 1. Top-up ₹1000
    const topup = await psm.topUpCustomerWallet({
      customerId: 'cust_normal_1',
      amountPaise: 100000,
      idempotencyKey: 'topup_normal_1'
    });
    assert.strictEqual(topup.success, true);
    assert.strictEqual(psm.getCustomerBalance('cust_normal_1').rupees, 1000);

    // 2. Escrow ₹350
    const escrow = await psm.reserveEscrow({
      tripId: 'TRIP_NORMAL_1',
      customerId: 'cust_normal_1',
      amountPaise: 35000,
      idempotencyKey: 'escrow_normal_1'
    });
    assert.strictEqual(escrow.success, true);
    assert.strictEqual(psm.getCustomerBalance('cust_normal_1').rupees, 650);
    assert.strictEqual(psm.getBalance('escrow:platform'), 35000);

    // 3. Settle ₹350 to driver with ₹35 (10%) commission
    const settle = await psm.settleTrip({
      tripId: 'TRIP_NORMAL_1',
      customerId: 'cust_normal_1',
      driverId: 'drv_normal_1',
      amountPaise: 35000,
      platformCommissionPaise: 3500,
      idempotencyKey: 'settle_normal_1'
    });
    assert.strictEqual(settle.success, true);
    assert.strictEqual(psm.getBalance('escrow:platform'), 0);
    assert.strictEqual(psm.getDriverBalance('drv_normal_1').rupees, 308.70); // 350 - 35 comm - 6.30 gst
    assert.strictEqual(psm.getBalance('platform:commission'), 3500);
    assert.strictEqual(psm.getBalance('platform:gst'), 630);

    // 4. Driver payout ₹200
    const payout = await psm.requestPayout({
      driverId: 'drv_normal_1',
      amountPaise: 20000,
      upiId: 'drv@upi',
      idempotencyKey: 'payout_normal_1'
    });
    assert.strictEqual(payout.success, true);
    assert.strictEqual(psm.getDriverBalance('drv_normal_1').rupees, 108.70); // 308.70 - 200
    assert.strictEqual(psm.getBalance('payout:clearing'), 20000);

    const audit = ledger.reconcile();
    assert.strictEqual(audit.ok, true);

    return { name: 'Normal Payment Flow', passed: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runNormalPaymentTest };
