'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');

async function runCrashRecoveryTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-crash-test-'));
  const filePath = path.join(dir, 'ledger.json');

  try {
    // Phase 1: Initialize service and perform transactions
    {
      const repo1 = new JsonLedgerRepository(filePath);
      const ledger1 = new LedgerService({ repository: repo1 });
      const psm1 = new PaymentStateMachine({ ledgerService: ledger1 });

      await psm1.topUpCustomerWallet({ customerId: 'c_crash', amountPaise: 80000, idempotencyKey: 'topup_crash' });
      await psm1.reserveEscrow({ tripId: 'TRIP_CRASH_1', customerId: 'c_crash', amountPaise: 30000, idempotencyKey: 'escrow_crash' });
      await psm1.settleTrip({ tripId: 'TRIP_CRASH_1', customerId: 'c_crash', driverId: 'd_crash', amountPaise: 30000, platformCommissionPaise: 3000, idempotencyKey: 'settle_crash' });
    }

    // Phase 2: Simulate process crash and reboot with a fresh service instance
    {
      const repo2 = new JsonLedgerRepository(filePath);
      const ledger2 = new LedgerService({ repository: repo2 });
      const psm2 = new PaymentStateMachine({ ledgerService: ledger2 });

      // Invariants check: exact balances and journals must be restored
      assert.strictEqual(psm2.getCustomerBalance('c_crash').rupees, 500); // 800 - 300 = 500
      assert.strictEqual(psm2.getDriverBalance('d_crash').rupees, 264.6); // 300 - 30 comm - 5.40 gst = 264.60
      assert.strictEqual(ledger2.getAccount('platform:commission').balancePaise, 3000);
      assert.strictEqual(ledger2.getAccount('platform:gst').balancePaise, 540);
      assert.strictEqual(ledger2.getAccount('escrow:platform').balancePaise, 0);

      // Verify idempotency survives crash
      const replay = await psm2.settleTrip({
        tripId: 'TRIP_CRASH_1', customerId: 'c_crash', driverId: 'd_crash',
        amountPaise: 30000, platformCommissionPaise: 3000, idempotencyKey: 'settle_crash'
      });
      assert.strictEqual(replay.idempotentReplay, true);

      const audit = ledger2.reconcile();
      assert.strictEqual(audit.ok, true);
    }

    return { name: 'Crash Recovery & State Integrity Test', passed: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runCrashRecoveryTest };
