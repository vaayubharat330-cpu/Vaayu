'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');

async function runPayoutSimulationTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-payout-test-'));
  const repo = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository: repo });
  const psm = new PaymentStateMachine({ ledgerService: ledger });

  try {
    // 1. Give driver ₹1,000 in earnings (via topup + trip escrow + settlement)
    await psm.topUpCustomerWallet({
      customerId: 'c_payout',
      amountPaise: 100000,
      idempotencyKey: 'topup_payout_test'
    });

    await psm.reserveEscrow({
      tripId: 'TRIP_PAYOUT_1',
      customerId: 'c_payout',
      amountPaise: 100000,
      idempotencyKey: 'escrow_payout_test'
    });

    await psm.settleTrip({
      tripId: 'TRIP_PAYOUT_1',
      customerId: 'c_payout',
      driverId: 'drv_payout_1',
      amountPaise: 100000,
      platformCommissionPaise: 0,
      idempotencyKey: 'settle_payout_test'
    });

    assert.strictEqual(psm.getDriverBalance('drv_payout_1').rupees, 1000);

    // 2. Request ₹600 payout
    const payout1 = await psm.requestPayout({
      driverId: 'drv_payout_1',
      amountPaise: 60000,
      upiId: 'driver1@okaxis',
      idempotencyKey: 'pay_req_600'
    });
    assert.strictEqual(payout1.success, true);
    assert.strictEqual(psm.getDriverBalance('drv_payout_1').rupees, 400);

    // 3. Duplicate payout attempt with same idempotency key: must replay safely
    const dupPayout = await psm.requestPayout({
      driverId: 'drv_payout_1',
      amountPaise: 60000,
      upiId: 'driver1@okaxis',
      idempotencyKey: 'pay_req_600'
    });
    assert.strictEqual(dupPayout.idempotentReplay, true);
    assert.strictEqual(psm.getDriverBalance('drv_payout_1').rupees, 400); // Balance unchanged!

    // 4. Overdraft payout attempt: Driver only has ₹400 left, attempts ₹600 payout
    let overdraftCaught = false;
    try {
      await psm.requestPayout({
        driverId: 'drv_payout_1',
        amountPaise: 60000,
        upiId: 'driver1@okaxis',
        idempotencyKey: 'pay_req_overdraft'
      });
    } catch (e) {
      if (e.code === 'INSUFFICIENT_FUNDS') overdraftCaught = true;
    }
    assert.strictEqual(overdraftCaught, true);
    assert.strictEqual(psm.getDriverBalance('drv_payout_1').rupees, 400);

    // 5. Simultaneous payouts racing on balance: Two simultaneous ₹300 requests
    // Total ₹600 attempted, only ₹400 available! Exactly 1 must succeed, 1 must fail.
    const [sim1, sim2] = await Promise.all([
      psm.requestPayout({ driverId: 'drv_payout_1', amountPaise: 30000, upiId: 'drv@upi', idempotencyKey: 'sim_payout_A' })
        .then(() => true).catch(e => e.code),
      psm.requestPayout({ driverId: 'drv_payout_1', amountPaise: 30000, upiId: 'drv@upi', idempotencyKey: 'sim_payout_B' })
        .then(() => true).catch(e => e.code),
    ]);

    const passes = [sim1, sim2].filter(r => r === true).length;
    const fails = [sim1, sim2].filter(r => r === 'INSUFFICIENT_FUNDS').length;
    assert.strictEqual(passes, 1);
    assert.strictEqual(fails, 1);
    assert.strictEqual(psm.getDriverBalance('drv_payout_1').rupees, 100); // 400 - 300 = 100 remaining!

    const reconciliation = ledger.reconcile();
    assert.strictEqual(reconciliation.ok, true);

    return { name: 'Driver Payout & Overdraft Racing Simulation', passed: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runPayoutSimulationTest };
