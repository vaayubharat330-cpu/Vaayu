'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');

async function runDuplicatePaymentTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-dup-test-'));
  const repo = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository: repo });
  const psm = new PaymentStateMachine({ ledgerService: ledger });

  try {
    await psm.topUpCustomerWallet({
      customerId: 'cust_dup_1',
      amountPaise: 50000, // ₹500
      idempotencyKey: 'topup_dup_1'
    });

    // Simulating double-click on Pay: two concurrent calls with exact same idempotency key
    const [req1, req2] = await Promise.all([
      psm.reserveEscrow({
        tripId: 'TRIP_DUP_1',
        customerId: 'cust_dup_1',
        amountPaise: 25000, // ₹250
        idempotencyKey: 'idemp_double_click_101'
      }),
      psm.reserveEscrow({
        tripId: 'TRIP_DUP_1',
        customerId: 'cust_dup_1',
        amountPaise: 25000, // ₹250
        idempotencyKey: 'idemp_double_click_101'
      })
    ]);

    assert.strictEqual(req1.success, true);
    assert.strictEqual(req2.success, true);
    assert.strictEqual(req1.transactionId, req2.transactionId); // Identical transaction!
    assert.strictEqual(req2.idempotentReplay, true);

    // Balance MUST be ₹250, NOT ₹0! (Zero double-debit)
    assert.strictEqual(psm.getCustomerBalance('cust_dup_1').rupees, 250);
    assert.strictEqual(psm.getBalance('escrow:platform'), 25000);

    // Test idempotency conflict: reuse same key with differing payload
    let conflictCaught = false;
    try {
      await psm.reserveEscrow({
        tripId: 'TRIP_DIFFERENT',
        customerId: 'cust_dup_1',
        amountPaise: 10000,
        idempotencyKey: 'idemp_double_click_101' // Same key, different trip & amount!
      });
    } catch (e) {
      if (e.code === 'IDEMPOTENCY_CONFLICT') conflictCaught = true;
    }
    assert.strictEqual(conflictCaught, true);

    const audit = ledger.reconcile();
    assert.strictEqual(audit.ok, true);

    return { name: 'Duplicate & Idempotency Protection', passed: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runDuplicatePaymentTest };
