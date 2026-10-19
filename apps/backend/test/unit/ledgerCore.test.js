const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { LedgerCore } = require('../../src/services/ledger/ledgerCore');

describe('VAAYU Double-Entry Ledger Core v0.1 Tests', () => {
  test('Complete Accounting Lifecycle & Concurrency Audit', async () => {
    const ledger = new LedgerCore();

    console.log('\nLedger Core Test');
    console.log('────────────────────────────────');

    // 1. Wallet top-up ₹1,000 (100,000 paise)
    const topupRes = await ledger.postEntry({
      type: 'WALLET_TOP_UP',
      referenceId: 'TOPUP_C1_1000',
      idempotencyKey: 'topup_c1_1000',
      postings: [
        { accountId: 'cash:external', direction: 'DEBIT', amount: 100000 },
        { accountId: 'customer:c1:wallet', direction: 'CREDIT', amount: 100000 }
      ]
    });
    assert.equal(topupRes.success, true);
    assert.equal(ledger.getBalance('customer:c1:wallet'), 100000);
    assert.equal(ledger.getBalance('cash:external'), 100000);
    console.log('Wallet top-up                 PASS');

    // 2. ₹350 trip escrow (35,000 paise)
    const escrowEntry = {
      type: 'TRIP_ESCROW',
      referenceId: 'TRIP_101',
      idempotencyKey: 'escrow_trip_101',
      postings: [
        { accountId: 'customer:c1:wallet', direction: 'DEBIT', amount: 35000 },
        { accountId: 'escrow:platform', direction: 'CREDIT', amount: 35000 }
      ]
    };
    const escrowRes = await ledger.postEntry(escrowEntry);
    assert.equal(escrowRes.success, true);
    assert.equal(ledger.getBalance('customer:c1:wallet'), 65000);
    assert.equal(ledger.getBalance('escrow:platform'), 35000);
    console.log('₹350 trip escrow             PASS');

    // 3. Duplicate payment idempotency check
    const dupRes = await ledger.postEntry(escrowEntry);
    assert.equal(dupRes.success, true);
    assert.equal(dupRes.entry.id, escrowRes.entry.id);
    assert.equal(ledger.getBalance('customer:c1:wallet'), 65000); // Balance unchanged!
    console.log('Duplicate payment            PASS');

    // 4. Trip settlement ₹350 (to driver d1 with ₹30 platform commission)
    const settleRes = await ledger.postEntry({
      type: 'TRIP_SETTLEMENT',
      referenceId: 'TRIP_101',
      idempotencyKey: 'settle_trip_101',
      postings: [
        { accountId: 'escrow:platform', direction: 'DEBIT', amount: 35000 },
        { accountId: 'driver:d1:earnings', direction: 'CREDIT', amount: 32000 },
        { accountId: 'platform:commission', direction: 'CREDIT', amount: 3000 }
      ]
    });
    assert.equal(settleRes.success, true);
    assert.equal(ledger.getBalance('escrow:platform'), 0);
    assert.equal(ledger.getBalance('driver:d1:earnings'), 32000);
    assert.equal(ledger.getBalance('platform:commission'), 3000);
    console.log('Trip settlement              PASS');

    // 5. ₹200 driver payout (20,000 paise)
    const payoutRes = await ledger.postEntry({
      type: 'DRIVER_PAYOUT',
      referenceId: 'PAYOUT_D1_200',
      idempotencyKey: 'payout_d1_200',
      postings: [
        { accountId: 'driver:d1:earnings', direction: 'DEBIT', amount: 20000 },
        { accountId: 'payout:clearing', direction: 'CREDIT', amount: 20000 }
      ]
    });
    assert.equal(payoutRes.success, true);
    assert.equal(ledger.getBalance('driver:d1:earnings'), 12000);
    assert.equal(ledger.getBalance('payout:clearing'), 20000);
    console.log('₹200 driver payout           PASS');

    // 6. Unbalanced journal rejection
    let unbalancedCaught = false;
    try {
      await ledger.postEntry({
        type: 'INVALID_UNBALANCED',
        referenceId: 'invalid_entry_1',
        idempotencyKey: 'invalid_entry_1',
        postings: [
          { accountId: 'customer:c1:wallet', direction: 'DEBIT', amount: 5000 },
          { accountId: 'escrow:platform', direction: 'CREDIT', amount: 3000 } // Unbalanced!
        ]
      });
    } catch (e) {
      if (e.code === 'UNBALANCED_JOURNAL_ENTRY') unbalancedCaught = true;
    }
    assert.equal(unbalancedCaught, true);
    console.log('Unbalanced journal rejection PASS');

    // 7. Concurrent wallet spending (10 simultaneous ₹50 debits against remaining ₹650)
    // Starting balance: ₹650 (65,000 paise)
    // 10 concurrent requests of ₹50 = ₹500 total
    const concurrentDebits = Array.from({ length: 10 }, (_, i) => 
      ledger.postEntry({
        type: 'CONCURRENT_DEBIT',
        referenceId: `concurrent_spend_${i}`,
        idempotencyKey: `concurrent_spend_${i}`,
        postings: [
          { accountId: 'customer:c1:wallet', direction: 'DEBIT', amount: 5000 },
          { accountId: 'cash:external', direction: 'CREDIT', amount: 5000 }
        ]
      })
    );

    const concurrentResults = await Promise.all(concurrentDebits);
    assert.equal(concurrentResults.every(r => r.success), true);
    // 65,000 - (10 * 5,000) = 15,000 paise = ₹150
    assert.equal(ledger.getBalance('customer:c1:wallet'), 15000);
    console.log('Concurrent wallet spending   PASS');

    // 8. Ledger reconciliation
    const audit = ledger.reconcile();
    assert.equal(audit.reconciled, true);
    assert.equal(audit.imbalancePaise, 0);
    console.log('Ledger reconciliation        PASS\n');

    console.log(`Journal entries: ${ledger.entries.length}`);
    console.log(`Final customer wallet: ₹${(ledger.getBalance('customer:c1:wallet') / 100).toFixed(0)}`);
    console.log(`Ledger imbalance: ₹${audit.imbalancePaise}`);
    console.log(`Reconciliation: ${audit.reconciled ? 'PASS' : 'FAIL'}\n`);
  });
});
