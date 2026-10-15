'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');

async function runConcurrentPaymentTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-concurrent-test-'));
  const repo = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository: repo });
  const psm = new PaymentStateMachine({ ledgerService: ledger });

  try {
    // Customer balance = ₹1,000 (100,000 paise)
    await psm.topUpCustomerWallet({
      customerId: 'cust_concurrent_race',
      amountPaise: 100000,
      idempotencyKey: 'topup_race_1'
    });

    assert.strictEqual(psm.getCustomerBalance('cust_concurrent_race').rupees, 1000);

    // Launch 3 simultaneous payment requests racing on the same balance:
    // Request A: PAY ₹350 (35,000 paise)
    // Request B: PAY ₹350 (35,000 paise)
    // Request C: PAY ₹500 (50,000 paise)
    // Total attempted: ₹1,200 (which exceeds the ₹1,000 balance!)
    const pA = psm.reserveEscrow({
      tripId: 'TRIP_RACE_A',
      customerId: 'cust_concurrent_race',
      amountPaise: 35000,
      idempotencyKey: 'race_req_A'
    }).then(r => ({ outcome: 'FULFILLED', result: r })).catch(e => ({ outcome: 'REJECTED', error: e }));

    const pB = psm.reserveEscrow({
      tripId: 'TRIP_RACE_B',
      customerId: 'cust_concurrent_race',
      amountPaise: 35000,
      idempotencyKey: 'race_req_B'
    }).then(r => ({ outcome: 'FULFILLED', result: r })).catch(e => ({ outcome: 'REJECTED', error: e }));

    const pC = psm.reserveEscrow({
      tripId: 'TRIP_RACE_C',
      customerId: 'cust_concurrent_race',
      amountPaise: 50000,
      idempotencyKey: 'race_req_C'
    }).then(r => ({ outcome: 'FULFILLED', result: r })).catch(e => ({ outcome: 'REJECTED', error: e }));

    const results = await Promise.all([pA, pB, pC]);

    const fulfilled = results.filter(r => r.outcome === 'FULFILLED');
    const rejected = results.filter(r => r.outcome === 'REJECTED');

    // Verify exactly 2 requests succeeded and 1 was cleanly rejected due to insufficient funds
    assert.strictEqual(fulfilled.length, 2);
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].error.code, 'INSUFFICIENT_FUNDS');

    const finalBal = psm.getCustomerBalance('cust_concurrent_race').rupees;
    // If A and B succeeded: 1000 - 350 - 350 = ₹300 remaining
    // If A and C succeeded: 1000 - 350 - 500 = ₹150 remaining
    // In either case, total spent MUST be <= ₹1,000, never ₹1,200!
    assert.ok([150, 300].includes(finalBal));
    assert.ok(psm.getBalance('escrow:platform') <= 100000);

    const audit = ledger.reconcile();
    assert.strictEqual(audit.ok, true);

    return { name: 'Concurrent Balance Race Condition Test', passed: true, finalBalanceRupees: finalBal };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runConcurrentPaymentTest };
