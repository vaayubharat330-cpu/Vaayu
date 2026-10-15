'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');

async function runTimeoutSimulationTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-timeout-test-'));
  const repo = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository: repo });
  const psm = new PaymentStateMachine({ ledgerService: ledger });

  try {
    await psm.topUpCustomerWallet({
      customerId: 'cust_timeout_1',
      amountPaise: 50000,
      idempotencyKey: 'topup_timeout_1'
    });

    // Client initiates payment
    const idempotencyKey = 'client_retry_key_4412';
    const initialResult = await psm.reserveEscrow({
      tripId: 'TRIP_TIMEOUT_1',
      customerId: 'cust_timeout_1',
      amountPaise: 20000,
      idempotencyKey
    });

    // Simulating client timeout: client disconnected before receiving response
    // Client retries 500ms later using the exact same idempotencyKey
    const retryResult = await psm.reserveEscrow({
      tripId: 'TRIP_TIMEOUT_1',
      customerId: 'cust_timeout_1',
      amountPaise: 20000,
      idempotencyKey
    });

    assert.strictEqual(retryResult.success, true);
    assert.strictEqual(retryResult.transactionId, initialResult.transactionId);
    assert.strictEqual(retryResult.idempotentReplay, true);
    // Ensure customer was NOT charged twice (balance is ₹300, not ₹100!)
    assert.strictEqual(psm.getCustomerBalance('cust_timeout_1').rupees, 300);

    const audit = ledger.reconcile();
    assert.strictEqual(audit.ok, true);

    return { name: 'Network Timeout & Client Retry Recovery', passed: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runTimeoutSimulationTest };
