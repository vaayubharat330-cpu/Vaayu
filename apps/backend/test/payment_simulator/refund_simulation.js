'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');

async function runRefundSimulationTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-refund-test-'));
  const repo = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository: repo });
  const psm = new PaymentStateMachine({ ledgerService: ledger });

  try {
    await psm.topUpCustomerWallet({
      customerId: 'cust_refund_1',
      amountPaise: 100000,
      idempotencyKey: 'topup_refund_1'
    });

    // 1. Escrow ₹450
    await psm.reserveEscrow({
      tripId: 'TRIP_CANCEL_1',
      customerId: 'cust_refund_1',
      amountPaise: 45000,
      idempotencyKey: 'escrow_cancel_1'
    });
    assert.strictEqual(psm.getCustomerBalance('cust_refund_1').rupees, 550);
    assert.strictEqual(psm.getBalance('escrow:platform'), 45000);

    // 2. Cancellation full refund
    const refundRes = await psm.refundTrip({
      tripId: 'TRIP_CANCEL_1',
      customerId: 'cust_refund_1',
      amountPaise: 45000,
      reason: 'Driver unreachable before arrival',
      idempotencyKey: 'refund_cancel_1'
    });
    assert.strictEqual(refundRes.success, true);
    // Escrow balance returns to 0, Customer wallet restored to ₹1,000
    assert.strictEqual(psm.getBalance('escrow:platform'), 0);
    assert.strictEqual(psm.getCustomerBalance('cust_refund_1').rupees, 1000);

    // 3. Partial dispute refund simulation
    // Trip 2: ₹500 booked & escrowed
    await psm.reserveEscrow({
      tripId: 'TRIP_PARTIAL_2',
      customerId: 'cust_refund_1',
      amountPaise: 50000,
      idempotencyKey: 'escrow_partial_2'
    });
    // Settle ₹400 to driver, ₹100 refunded back to customer due to delay discount
    await psm.refundTrip({
      tripId: 'TRIP_PARTIAL_2',
      customerId: 'cust_refund_1',
      amountPaise: 10000, // ₹100 partial refund
      reason: '15 min dark store delay compensation',
      idempotencyKey: 'partial_refund_2'
    });
    await psm.settleTrip({
      tripId: 'TRIP_PARTIAL_2',
      customerId: 'cust_refund_1',
      driverId: 'drv_partial_2',
      amountPaise: 40000, // Remaining ₹400 settled to driver
      platformCommissionPaise: 4000,
      idempotencyKey: 'settle_partial_2'
    });

    assert.strictEqual(psm.getBalance('escrow:platform'), 0);
    assert.strictEqual(psm.getCustomerBalance('cust_refund_1').rupees, 600); // 1000 - 500 + 100 = 600
    assert.strictEqual(psm.getDriverBalance('drv_partial_2').rupees, 352.80);

    const audit = ledger.reconcile();
    assert.strictEqual(audit.ok, true);

    return { name: 'Full & Partial Refund Simulation', passed: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runRefundSimulationTest };
