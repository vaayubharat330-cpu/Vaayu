'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { runMigrations } = require('../../src/db/runLedgerMigrations');

test('VAAYU Phase F.1: PostgreSQL Ledger Durability & Invariants Suite', async (t) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip('Skipping PostgreSQL tests: DATABASE_ADMIN_URL / DATABASE_URL not configured.');
    return;
  }

  // Ensure migrations and system accounts are applied
  await runMigrations();

  const pool = new PostgresPool({ connectionString });
  const repo = new PostgresLedgerRepository(pool);

  // Clean test accounts / test data prefix
  const testPrefix = `test_f1_${Date.now()}`;
  const custAccount = `customer:${testPrefix}:wallet`;
  const drvAccount = `driver:${testPrefix}:earnings`;

  t.after(async () => {
    // Teardown test pool
    await pool.end();
  });

  await t.test('1. Initial System Accounts & Account Creation', async () => {
    const acc = await repo.ensureAccount(custAccount, 'LIABILITY', 'CREDIT');
    assert.strictEqual(acc.accountId, custAccount);
    assert.strictEqual(acc.accountType, 'LIABILITY');
    assert.strictEqual(acc.normalBalance, 'CREDIT');
    assert.strictEqual(acc.balancePaise, 0);

    const fetched = await repo.getAccount(custAccount);
    assert.strictEqual(fetched.accountId, custAccount);
  });

  await t.test('2. Atomic Double-Entry Top-up with Balance Materialization', async () => {
    const key = `TOP_${testPrefix}_1`;
    const result = await repo.postJournalEntry({
      referenceId: `REF_${testPrefix}_TOP1`,
      idempotencyKey: key,
      description: 'Customer wallet top-up INR 500',
      postings: [
        { accountId: 'cash:external', side: 'DEBIT', amountPaise: 50000 },
        { accountId: custAccount, side: 'CREDIT', amountPaise: 50000 }
      ]
    });

    assert.strictEqual(result.idempotentReplay, false);
    assert.strictEqual(result.totalPaise, 50000);
    assert.match(result.entryId, /^JE-\d{10}$/);

    const cust = await repo.getAccount(custAccount);
    assert.strictEqual(cust.balancePaise, 50000);
    assert.strictEqual(cust.creditPaise, 50000);

    const cash = await repo.getAccount('cash:external');
    assert.ok(cash.balancePaise >= 50000);
  });

  await t.test('3. Idempotency Guarantees: Replay vs Payload Mismatch Conflict', async () => {
    const key = `TOP_${testPrefix}_IDEMP`;
    // First attempt
    const r1 = await repo.postJournalEntry({
      referenceId: `REF_${testPrefix}_ID1`,
      idempotencyKey: key,
      description: 'First attempt INR 100',
      postings: [
        { accountId: 'cash:external', side: 'DEBIT', amountPaise: 10000 },
        { accountId: custAccount, side: 'CREDIT', amountPaise: 10000 }
      ]
    });
    assert.strictEqual(r1.idempotentReplay, false);

    // Identical replay -> returns cached response
    const r2 = await repo.postJournalEntry({
      referenceId: `REF_${testPrefix}_ID1`,
      idempotencyKey: key,
      description: 'First attempt INR 100',
      postings: [
        { accountId: 'cash:external', side: 'DEBIT', amountPaise: 10000 },
        { accountId: custAccount, side: 'CREDIT', amountPaise: 10000 }
      ]
    });
    assert.strictEqual(r2.idempotentReplay, true);
    assert.strictEqual(r2.entryId, r1.entryId);

    // Same key, altered payload -> IDEMPOTENCY_KEY_REUSE
    await assert.rejects(
      async () => {
        await repo.postJournalEntry({
          referenceId: `REF_${testPrefix}_ID1`,
          idempotencyKey: key,
          description: 'Altered attempt INR 200',
          postings: [
            { accountId: 'cash:external', side: 'DEBIT', amountPaise: 20000 },
            { accountId: custAccount, side: 'CREDIT', amountPaise: 20000 }
          ]
        });
      },
      (err) => {
        assert.strictEqual(err.code, 'IDEMPOTENCY_KEY_REUSE');
        return true;
      }
    );
  });

  await t.test('4. Double-Entry Unbalanced Entry Rejection', async () => {
    const key = `UNBAL_${testPrefix}`;
    await assert.rejects(
      async () => {
        await repo.postJournalEntry({
          referenceId: `REF_${testPrefix}_UNBAL`,
          idempotencyKey: key,
          description: 'Unbalanced debits 100 vs credits 50',
          postings: [
            { accountId: 'cash:external', side: 'DEBIT', amountPaise: 10000 },
            { accountId: custAccount, side: 'CREDIT', amountPaise: 5000 }
          ]
        });
      },
      (err) => {
        assert.strictEqual(err.code, 'UNBALANCED_ENTRY');
        return true;
      }
    );
  });

  await t.test('5. Atomic Rollback on Overdraft (Insufficient Funds)', async () => {
    const key = `OVER_${testPrefix}`;
    const initialCust = await repo.getAccount(custAccount);

    await assert.rejects(
      async () => {
        await repo.postJournalEntry({
          referenceId: `REF_${testPrefix}_OVER`,
          idempotencyKey: key,
          description: 'Attempt to spend more than wallet balance',
          postings: [
            { accountId: custAccount, side: 'DEBIT', amountPaise: initialCust.balancePaise + 999999 },
            { accountId: 'escrow:platform', side: 'CREDIT', amountPaise: initialCust.balancePaise + 999999 }
          ]
        });
      },
      (err) => {
        assert.strictEqual(err.code, 'INSUFFICIENT_FUNDS');
        return true;
      }
    );

    // Verify atomic rollback: customer balance remained unchanged
    const afterCust = await repo.getAccount(custAccount);
    assert.strictEqual(afterCust.balancePaise, initialCust.balancePaise);
  });

  await t.test('6. Database Immutability Triggers Enforcement', async () => {
    // Attempting UPDATE or DELETE on ledger_journal_entries or ledger_postings must throw
    const res = await pool.query('SELECT entry_id FROM ledger_journal_entries LIMIT 1');
    assert.ok(res.rows.length > 0, 'Should have at least one journal entry');
    const entryId = res.rows[0].entry_id;

    // A. UPDATE on journal entry -> rejected by trigger
    await assert.rejects(
      async () => {
        await pool.query('UPDATE ledger_journal_entries SET description = $1 WHERE entry_id = $2', ['Tampered', entryId]);
      },
      /ledger_journal_entries is strictly immutable/
    );

    // B. DELETE on journal entry -> rejected by trigger
    await assert.rejects(
      async () => {
        await pool.query('DELETE FROM ledger_journal_entries WHERE entry_id = $1', [entryId]);
      },
      /ledger_journal_entries is strictly immutable/
    );

    // C. UPDATE on postings -> rejected by trigger
    const postRes = await pool.query('SELECT posting_id FROM ledger_postings LIMIT 1');
    const postingId = postRes.rows[0].posting_id;

    await assert.rejects(
      async () => {
        await pool.query('UPDATE ledger_postings SET amount_paise = 99999 WHERE posting_id = $1', [postingId]);
      },
      /ledger_postings is strictly immutable/
    );
  });

  await t.test('7. Payment Lifecycle, OCC Versioning & Transactional Outbox', async () => {
    const tripId = `TRIP_${testPrefix}_OCC`;
    const paymentId = `PAY_${tripId}`;

    // 1. Escrow hold with Outbox Event
    const escrowResult = await repo.postJournalEntry({
      referenceId: tripId,
      idempotencyKey: `VAAYU:${tripId}:ESCROW`,
      description: 'Trip fare escrow hold INR 300',
      postings: [
        { accountId: custAccount, side: 'DEBIT', amountPaise: 30000 },
        { accountId: 'escrow:platform', side: 'CREDIT', amountPaise: 30000 }
      ],
      paymentRecord: {
        paymentId,
        tripId,
        orderId: tripId,
        customerId: `CUST_${testPrefix}`,
        amountPaise: 30000,
        escrowPaise: 30000,
        state: 'ESCROWED',
        version: 1
      },
      outboxEvent: {
        eventId: `EVT_${testPrefix}_ESCROW`,
        aggregateType: 'PAYMENT',
        aggregateId: paymentId,
        eventType: 'PaymentEscrowed',
        payload: { tripId, paymentId, amountPaise: 30000 }
      }
    });

    assert.strictEqual(escrowResult.idempotentReplay, false);

    // Verify Payment Transaction row
    const tx = await repo.getPayment(paymentId);
    assert.strictEqual(tx.paymentId, paymentId);
    assert.strictEqual(tx.state, 'ESCROWED');
    assert.strictEqual(tx.escrowPaise, 30000);

    // Verify Outbox Event exists and is PENDING
    const outboxRes = await pool.query('SELECT * FROM payment_outbox WHERE event_id = $1', [`EVT_${testPrefix}_ESCROW`]);
    assert.strictEqual(outboxRes.rows.length, 1);
    assert.strictEqual(outboxRes.rows[0].status, 'PENDING');
    assert.strictEqual(outboxRes.rows[0].event_type, 'PaymentEscrowed');

    // 2. Settlement with commission & GST split
    // Fare INR 300: Commission INR 30 (3,000 paise), GST INR 5.40 (540 paise), Driver INR 264.60 (26,460 paise)
    const settleResult = await repo.postJournalEntry({
      referenceId: tripId,
      idempotencyKey: `VAAYU:${tripId}:SETTLE`,
      description: 'Trip settlement to driver',
      postings: [
        { accountId: 'escrow:platform', side: 'DEBIT', amountPaise: 30000 },
        { accountId: drvAccount, side: 'CREDIT', amountPaise: 26460 },
        { accountId: 'platform:commission', side: 'CREDIT', amountPaise: 3000 },
        { accountId: 'platform:gst', side: 'CREDIT', amountPaise: 540 }
      ],
      paymentRecord: {
        paymentId,
        tripId,
        orderId: tripId,
        customerId: `CUST_${testPrefix}`,
        driverId: `DRV_${testPrefix}`,
        amountPaise: 30000,
        escrowPaise: 0,
        driverEarningsPaise: 26460,
        commissionPaise: 3000,
        gstPaise: 540,
        state: 'SETTLED',
        version: tx.version + 1
      },
      outboxEvent: {
        eventId: `EVT_${testPrefix}_SETTLE`,
        aggregateType: 'PAYMENT',
        aggregateId: paymentId,
        eventType: 'PaymentSettled',
        payload: { tripId, paymentId, driverEarningsPaise: 26460, commissionPaise: 3000 }
      }
    });

    assert.strictEqual(settleResult.idempotentReplay, false);

    const settledTx = await repo.getPayment(paymentId);
    assert.strictEqual(settledTx.state, 'SETTLED');
    assert.strictEqual(settledTx.driverEarningsPaise, 26460);
    assert.strictEqual(settledTx.commissionPaise, 3000);
    assert.strictEqual(settledTx.gstPaise, 540);
    assert.strictEqual(settledTx.escrowPaise, 0);

    const drvAcc = await repo.getAccount(drvAccount);
    assert.strictEqual(drvAcc.balancePaise, 26460);
  });

  await t.test('8. Full PostgreSQL Authoritative Reconciliation', async () => {
    const rec = await repo.reconcile();
    assert.strictEqual(rec.ok, true, `Reconciliation problems: ${rec.problems.join(', ')}`);
    assert.strictEqual(rec.problems.length, 0);
    assert.ok(rec.journalEntries >= 3);

    const audit = await repo.getLedgerAudit();
    assert.strictEqual(audit.invariants.debitsEqualCredits, true);
    assert.strictEqual(audit.invariants.accountingEquationSatisfied, true);
    assert.strictEqual(audit.statutoryGst.ratioCompliant, true);
  });
});
