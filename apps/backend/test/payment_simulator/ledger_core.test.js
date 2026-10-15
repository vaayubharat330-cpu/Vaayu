'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LedgerService, JsonLedgerRepository, LedgerError, ACCOUNT_TYPES } = require('../../src/services/ledger/ledgerService');

function createLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-ledger-'));
  const repository = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository, clock: () => '2026-10-12T00:00:00.000Z' });
  ledger.createAccount({ accountId: 'cash:external', type: ACCOUNT_TYPES.ASSET });
  ledger.createAccount({ accountId: 'escrow:platform', type: ACCOUNT_TYPES.LIABILITY });
  ledger.createAccount({ accountId: 'platform:commission', type: ACCOUNT_TYPES.REVENUE });
  ledger.createAccount({ accountId: 'payout:clearing', type: ACCOUNT_TYPES.LIABILITY });
  ledger.createAccount({ accountId: 'customer:c1:wallet', type: ACCOUNT_TYPES.LIABILITY });
  ledger.createAccount({ accountId: 'driver:d1:earnings', type: ACCOUNT_TYPES.LIABILITY });
  return { ledger, dir };
}

async function run() {
  const { ledger, dir } = createLedger();
  try {
    await ledger.postJournalEntry({
      referenceId: 'TOPUP-1', idempotencyKey: 'TOPUP-1', description: 'Simulated wallet top-up',
      postings: [
        { accountId: 'cash:external', side: 'DEBIT', amountPaise: 100000 },
        { accountId: 'customer:c1:wallet', side: 'CREDIT', amountPaise: 100000 },
      ],
    });

    const booking = await ledger.postJournalEntry({
      referenceId: 'TRIP-1-PAYMENT', idempotencyKey: 'TRIP-1-PAYMENT', description: 'Trip wallet escrow',
      postings: [
        { accountId: 'customer:c1:wallet', side: 'DEBIT', amountPaise: 35000 },
        { accountId: 'escrow:platform', side: 'CREDIT', amountPaise: 35000 },
      ],
    });
    assert.strictEqual(booking.totalPaise, 35000);
    assert.strictEqual(ledger.getAccount('customer:c1:wallet').balancePaise, 65000);

    const replay = await ledger.postJournalEntry({
      referenceId: 'TRIP-1-PAYMENT', idempotencyKey: 'TRIP-1-PAYMENT', description: 'Trip wallet escrow',
      postings: [
        { accountId: 'customer:c1:wallet', side: 'DEBIT', amountPaise: 35000 },
        { accountId: 'escrow:platform', side: 'CREDIT', amountPaise: 35000 },
      ],
    });
    assert.strictEqual(replay.idempotentReplay, true);
    assert.strictEqual(ledger.getAccount('customer:c1:wallet').balancePaise, 65000);

    await ledger.postJournalEntry({
      referenceId: 'TRIP-1-SETTLE', idempotencyKey: 'TRIP-1-SETTLE', description: 'Trip settlement',
      postings: [
        { accountId: 'escrow:platform', side: 'DEBIT', amountPaise: 35000 },
        { accountId: 'driver:d1:earnings', side: 'CREDIT', amountPaise: 35000 },
      ],
    });

    await ledger.postJournalEntry({
      referenceId: 'PAYOUT-1', idempotencyKey: 'PAYOUT-1', description: 'Driver payout',
      postings: [
        { accountId: 'driver:d1:earnings', side: 'DEBIT', amountPaise: 20000 },
        { accountId: 'payout:clearing', side: 'CREDIT', amountPaise: 20000 },
      ],
    });

    assert.strictEqual(ledger.getAccount('driver:d1:earnings').balancePaise, 15000);
    assert.strictEqual(ledger.getAccount('escrow:platform').balancePaise, 0);

    await assert.rejects(() => ledger.postJournalEntry({
      referenceId: 'BAD-1', idempotencyKey: 'BAD-1', description: 'Unbalanced',
      postings: [
        { accountId: 'customer:c1:wallet', side: 'DEBIT', amountPaise: 100 },
        { accountId: 'escrow:platform', side: 'CREDIT', amountPaise: 99 },
      ],
    }), e => e instanceof LedgerError && e.code === 'UNBALANCED_ENTRY');

    const concurrent = Array.from({ length: 10 }, (_, i) => ledger.postJournalEntry({
      referenceId: `RACE-${i}`,
      idempotencyKey: `RACE-${i}`,
      description: 'Concurrent wallet spend',
      postings: [
        { accountId: 'customer:c1:wallet', side: 'DEBIT', amountPaise: 5000 },
        { accountId: 'escrow:platform', side: 'CREDIT', amountPaise: 5000 },
      ],
    }).then(() => true).catch(e => e.code));
    const results = await Promise.all(concurrent);
    assert.strictEqual(results.filter(v => v === true).length, 10);
    assert.strictEqual(ledger.getAccount('customer:c1:wallet').balancePaise, 15000);

    const reconciliation = ledger.reconcile();
    assert.strictEqual(reconciliation.ok, true, JSON.stringify(reconciliation));
    console.log(JSON.stringify({ status: 'PASS', reconciliation, walletPaise: ledger.getAccount('customer:c1:wallet').balancePaise }, null, 2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
