'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { runMigrations } = require('../../src/db/runLedgerMigrations');
const { ShadowPaymentVerifier } = require('../../src/services/ledger/shadowPaymentService');

test('VAAYU Phase F.2: Distributed Concurrency & Cluster Safety Suite', async (t) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip('Skipping PostgreSQL cluster concurrency tests: DATABASE_ADMIN_URL not configured.');
    return;
  }

  await runMigrations();

  const pool = new PostgresPool({ connectionString, max: 40, connectionTimeoutMillis: 30000 });
  const repo = new PostgresLedgerRepository(pool);
  const suiteId = `clust_${Date.now()}`;

  t.after(async () => {
    await pool.end();
  });

  await t.test('1. 20 Concurrent Workers -> Same Escrow Hold (Zero Double Debits)', async () => {
    const custId = `CUST_${suiteId}_1`;
    const tripId = `TRIP_${suiteId}_1`;
    const key = `VAAYU:${tripId}:ESCROW`;

    // Customer wallet seeded with 50,000 paise (INR 500)
    await repo.topUpCustomerWallet({
      customerId: custId,
      amountPaise: 50000,
      idempotencyKey: `TOP_${suiteId}_1`
    });

    // 20 concurrent workers try to escrow 30,000 paise with the same idempotency key
    const workers = Array.from({ length: 20 }, (_, idx) => {
      return repo.reserveEscrow({
        tripId,
        orderId: tripId,
        customerId: custId,
        amountPaise: 30000,
        idempotencyKey: key
      });
    });

    const results = await Promise.all(workers);

    // Exactly 1 primary execution, 19 idempotent replays
    const primaryCount = results.filter(r => r.idempotentReplay === false).length;
    const replayCount = results.filter(r => r.idempotentReplay === true).length;

    assert.strictEqual(primaryCount, 1, 'Exactly one worker must perform the primary financial mutation');
    assert.strictEqual(replayCount, 19, 'The other 19 workers must receive idempotent cached replays');

    // Customer balance must be exactly 20,000 paise (50,000 - 30,000)
    const custBal = await repo.getCustomerBalance(custId);
    assert.strictEqual(custBal.paise, 20000, 'Customer wallet must only be debited once');

    // Escrow account must have exactly 30,000 paise
    const escrowAcc = await repo.getAccount('escrow:platform');
    assert.ok(escrowAcc.balancePaise >= 30000);
  });

  await t.test('2. 20 Concurrent Workers -> Same Refund (No Over-Refund Invariant)', async () => {
    const custId = `CUST_${suiteId}_2`;
    const tripId = `TRIP_${suiteId}_2`;

    // Seed customer and escrow 40,000 paise
    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: 50000, idempotencyKey: `TOP_${suiteId}_2` });
    await repo.reserveEscrow({ tripId, customerId: custId, amountPaise: 40000 });

    // 20 workers concurrently attempt to refund 5,000 paise each with unique idempotency keys
    // Total attempted: 20 * 5,000 = 100,000 paise (> 40,000 available escrow!)
    const refundWorkers = Array.from({ length: 20 }, (_, idx) => {
      return repo.refundTrip({
        tripId,
        amountPaise: 5000,
        reason: `Concurrent refund test worker ${idx}`,
        idempotencyKey: `VAAYU:${tripId}:REFUND:W${idx}`
      }).then(
        res => ({ success: true, res }),
        err => ({ success: false, code: err.code })
      );
    });

    const refundResults = await Promise.all(refundWorkers);
    const successes = refundResults.filter(r => r.success);
    const failures = refundResults.filter(r => !r.success);

    // Exactly 8 refunds of 5,000 paise can succeed (8 * 5,000 = 40,000 paise)
    assert.strictEqual(successes.length, 8, 'Exactly 8 refunds must succeed to deplete 40,000 paise escrow');
    assert.strictEqual(failures.length, 12, 'The remaining 12 refunds must be rejected');

    for (const f of failures) {
      assert.ok(['REFUND_LIMIT_EXCEEDED', 'ILLEGAL_PAYMENT_TRANSITION'].includes(f.code));
    }

    // Verify payment transaction state is REFUNDED and escrow is 0
    const finalTx = await repo.getPaymentByTripId(tripId);
    assert.strictEqual(finalTx.state, 'REFUNDED');
    assert.strictEqual(finalTx.escrowPaise, 0);
    assert.strictEqual(finalTx.refundedPaise, 40000);
  });

  await t.test('3. Settlement vs Expiration Race Across Separate Workers', async () => {
    const custId = `CUST_${suiteId}_3`;
    const drvId = `DRV_${suiteId}_3`;
    const tripId = `TRIP_${suiteId}_3`;

    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: 30000, idempotencyKey: `TOP_${suiteId}_3` });
    await repo.reserveEscrow({ tripId, customerId: custId, amountPaise: 25000 });

    // Competing operations launch simultaneously
    const [settleRes, expireRes] = await Promise.allSettled([
      repo.settleTrip({ tripId, driverId: drvId, amountPaise: 25000 }),
      repo.expirePayment({ tripId, reason: 'Timeout expiration' })
    ]);

    // Exactly one must fulfill, exactly one must reject
    const fulfilled = [settleRes, expireRes].filter(r => r.status === 'fulfilled');
    const rejected = [settleRes, expireRes].filter(r => r.status === 'rejected');

    assert.strictEqual(fulfilled.length, 1, 'Exactly one operation must win the settlement vs expiry race');
    assert.strictEqual(rejected.length, 1, 'The competing operation must reject cleanly');

    const winnerTx = await repo.getPaymentByTripId(tripId);
    assert.ok(['SETTLED', 'EXPIRED'].includes(winnerTx.state));
    assert.strictEqual(winnerTx.escrowPaise, 0);
  });

  await t.test('4. Settlement vs Full Refund Race Across Separate Workers', async () => {
    const custId = `CUST_${suiteId}_4`;
    const drvId = `DRV_${suiteId}_4`;
    const tripId = `TRIP_${suiteId}_4`;

    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: 35000, idempotencyKey: `TOP_${suiteId}_4` });
    await repo.reserveEscrow({ tripId, customerId: custId, amountPaise: 35000 });

    const [settleRes, refundRes] = await Promise.allSettled([
      repo.settleTrip({ tripId, driverId: drvId, amountPaise: 35000 }),
      repo.refundTrip({ tripId, amountPaise: 35000, reason: 'Passenger cancelled' })
    ]);

    const fulfilled = [settleRes, refundRes].filter(r => r.status === 'fulfilled');
    const rejected = [settleRes, refundRes].filter(r => r.status === 'rejected');

    assert.strictEqual(fulfilled.length, 1, 'Exactly one operation must win settlement vs refund race');
    assert.strictEqual(rejected.length, 1, 'The competing operation must reject cleanly');

    const winnerTx = await repo.getPaymentByTripId(tripId);
    assert.ok(['SETTLED', 'REFUNDED'].includes(winnerTx.state));
    assert.strictEqual(winnerTx.escrowPaise, 0);
  });

  await t.test('5. Concurrent Driver Payouts (Zero Lost Updates)', async () => {
    const drvId = `DRV_${suiteId}_5`;
    const drvAccount = repo.getDriverAccountId(drvId);

    // Credit driver with 50,000 paise (direct double-entry seed)
    await repo.postJournalEntry({
      referenceId: `SEED_${suiteId}_DRV5`,
      idempotencyKey: `KEY_SEED_${suiteId}_DRV5`,
      description: 'Seed driver earnings',
      postings: [
        { accountId: 'cash:external', side: 'DEBIT', amountPaise: 50000 },
        { accountId: drvAccount, side: 'CREDIT', amountPaise: 50000 }
      ]
    });

    // 5 concurrent payout requests of 10,000 paise each
    const payoutCalls = Array.from({ length: 5 }, (_, idx) => {
      return repo.payoutDriver({
        driverId: drvId,
        amountPaise: 10000,
        idempotencyKey: `PAYOUT_${suiteId}_${idx}`
      });
    });

    const results = await Promise.all(payoutCalls);
    for (const r of results) {
      assert.strictEqual(r.success, true);
    }

    // Driver balance must be exactly 0 paise (no lost updates)
    const finalDrvBal = await repo.getDriverBalance(drvId);
    assert.strictEqual(finalDrvBal.paise, 0);

    // 6th payout must fail with INSUFFICIENT_FUNDS
    await assert.rejects(
      async () => {
        await repo.payoutDriver({
          driverId: drvId,
          amountPaise: 10000,
          idempotencyKey: `PAYOUT_${suiteId}_6TH`
        });
      },
      (err) => {
        assert.strictEqual(err.code, 'INSUFFICIENT_FUNDS');
        return true;
      }
    );
  });

  await t.test('6. Same Idempotency Key Across Distinct Connection Clients', async () => {
    const key = `IDEMP_DISTINCT_${suiteId}`;
    const custId = `CUST_${suiteId}_6`;
    const custAccount = repo.getCustomerAccountId(custId);

    // 10 distinct connection pool calls with the exact same idempotency key
    const calls = Array.from({ length: 10 }, () => {
      return repo.postJournalEntry({
        referenceId: `REF_${key}`,
        idempotencyKey: key,
        description: 'Idempotency concurrency test',
        postings: [
          { accountId: 'cash:external', side: 'DEBIT', amountPaise: 15000 },
          { accountId: custAccount, side: 'CREDIT', amountPaise: 15000 }
        ]
      });
    });

    const results = await Promise.all(calls);
    const entryIds = new Set(results.map(r => r.entryId));

    // All callers must receive the exact same entryId
    assert.strictEqual(entryIds.size, 1);

    // Verify PostgreSQL table contains exactly 1 row for this idempotency key
    const countRes = await pool.query('SELECT COUNT(*) as count FROM ledger_journal_entries WHERE idempotency_key = $1', [key]);
    assert.strictEqual(parseInt(countRes.rows[0].count, 10), 1);
  });

  await t.test('7. Different Idempotency Keys for Same Payment State Conflict', async () => {
    const custId = `CUST_${suiteId}_7`;
    const drvId = `DRV_${suiteId}_7`;
    const tripId = `TRIP_${suiteId}_7`;

    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: 20000, idempotencyKey: `TOP_${suiteId}_7` });
    await repo.reserveEscrow({ tripId, customerId: custId, amountPaise: 20000 });
    await repo.settleTrip({ tripId, driverId: drvId, amountPaise: 20000 });

    // Payment is now SETTLED. Competing call with a DIFFERENT idempotency key tries to settle again
    await assert.rejects(
      async () => {
        await repo.settleTrip({
          tripId,
          driverId: drvId,
          amountPaise: 20000,
          idempotencyKey: `NEW_SETTLE_KEY_DIFFERENT_${Date.now()}`
        });
      },
      (err) => {
        assert.ok(['ILLEGAL_PAYMENT_TRANSITION', 'PAYMENT_STATE_CONFLICT'].includes(err.code));
        return true;
      }
    );
  });

  await t.test('8. Deadlock Torture: Reversed Account Order Serialization', async () => {
    const accA = `account:deadlock:${suiteId}:A`;
    const accB = `account:deadlock:${suiteId}:B`;

    await repo.ensureAccount(accA, 'LIABILITY', 'CREDIT');
    await repo.ensureAccount(accB, 'LIABILITY', 'CREDIT');

    // Seed both accounts
    await repo.postJournalEntry({
      referenceId: `SEED_${suiteId}_DLA`,
      idempotencyKey: `SEED_${suiteId}_DLA`,
      description: 'Seed acc A',
      postings: [{ accountId: 'cash:external', side: 'DEBIT', amountPaise: 100000 }, { accountId: accA, side: 'CREDIT', amountPaise: 100000 }]
    });
    await repo.postJournalEntry({
      referenceId: `SEED_${suiteId}_DLB`,
      idempotencyKey: `SEED_${suiteId}_DLB`,
      description: 'Seed acc B',
      postings: [{ accountId: 'cash:external', side: 'DEBIT', amountPaise: 100000 }, { accountId: accB, side: 'CREDIT', amountPaise: 100000 }]
    });

    // Worker 1: [accA, accB]
    // Worker 2: [accB, accA] (deliberately reversed!)
    // Run 30 concurrent pairs simultaneously
    const pairs = [];
    for (let i = 0; i < 30; i++) {
      const p1 = repo.postJournalEntry({
        referenceId: `DL_PAIR_${i}_1`,
        idempotencyKey: `KEY_DL_${suiteId}_${i}_1`,
        description: `Transfer A to B pair ${i}`,
        postings: [
          { accountId: accA, side: 'DEBIT', amountPaise: 100 },
          { accountId: accB, side: 'CREDIT', amountPaise: 100 }
        ]
      });

      const p2 = repo.postJournalEntry({
        referenceId: `DL_PAIR_${i}_2`,
        idempotencyKey: `KEY_DL_${suiteId}_${i}_2`,
        description: `Transfer B to A pair ${i} (reversed order)`,
        postings: [
          { accountId: accB, side: 'DEBIT', amountPaise: 100 },
          { accountId: accA, side: 'CREDIT', amountPaise: 100 }
        ]
      });

      pairs.push(p1, p2);
    }

    // Must resolve with ZERO deadlocks (code 40P01) because repository sorts account_id lexicographically
    const deadLockResults = await Promise.all(pairs);
    assert.strictEqual(deadLockResults.length, 60);
  });

  await t.test('9. Process Termination & Mid-Transaction Connection Abort', async () => {
    // Open a direct client connection and begin transaction
    const client = await pool.pool.connect();
    const abortKey = `ABORT_${suiteId}_CRASH`;
    let entryId;

    try {
      await client.query('BEGIN');
      const seqRes = await client.query("SELECT nextval('ledger_journal_entries_sequence_seq') as next_seq");
      const nextSeq = Number(seqRes.rows[0].next_seq);
      entryId = `JE-${String(nextSeq).padStart(10, '0')}`;

      // Insert uncommitted journal entry
      await client.query(`
        INSERT INTO ledger_journal_entries (entry_id, sequence, reference_id, idempotency_key, description, total_paise, metadata, created_at)
        VALUES ($1, $2, 'CRASH_TEST', $3, 'Uncommitted crash entry', 5000, '{}', NOW());
      `, [entryId, nextSeq, abortKey]);

      // Abruptly terminate the transaction without commit
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Verify PostgreSQL cleanly rolled back: 0 orphaned rows
    const verifyRes = await pool.query('SELECT * FROM ledger_journal_entries WHERE entry_id = $1', [entryId]);
    assert.strictEqual(verifyRes.rows.length, 0, 'Uncommitted aborted transaction must leave zero rows');
  });

  await t.test('10. Multi-Worker High-Volume Cluster Stress & Authoritative SQL Reconciliation', async () => {
    const workerCount = 10;
    const opsPerWorker = 25;
    const allOperations = [];

    for (let w = 0; w < workerCount; w++) {
      const workerCust = `CUST_STRESS_${suiteId}_W${w}`;
      const workerDrv = `DRV_STRESS_${suiteId}_W${w}`;

      allOperations.push(async () => {
        // Step 1: Top up
        await repo.topUpCustomerWallet({
          customerId: workerCust,
          amountPaise: 100000,
          idempotencyKey: `TOP_STRESS_${suiteId}_W${w}`
        });

        // Step 2: Run loop of trips
        for (let i = 0; i < opsPerWorker; i++) {
          const tripId = `TRIP_STRESS_${suiteId}_W${w}_${i}`;
          await repo.reserveEscrow({
            tripId,
            customerId: workerCust,
            amountPaise: 2000,
            idempotencyKey: `VAAYU:${tripId}:ESCROW`
          });

          if (i % 2 === 0) {
            // Settle to driver
            await repo.settleTrip({
              tripId,
              driverId: workerDrv,
              amountPaise: 2000,
              idempotencyKey: `VAAYU:${tripId}:SETTLE`
            });
          } else {
            // Refund back to customer
            await repo.refundTrip({
              tripId,
              amountPaise: 2000,
              reason: 'Stress refund',
              idempotencyKey: `VAAYU:${tripId}:REFUND`
            });
          }
        }
      });
    }

    // Execute all 10 worker pipelines concurrently
    await Promise.all(allOperations.map(fn => fn()));

    // Run authoritative PostgreSQL double-entry reconciliation across the entire database
    const rec = await repo.reconcile();
    assert.strictEqual(rec.ok, true, `Reconciliation detected imbalances: ${rec.problems.join(', ')}`);
    assert.strictEqual(rec.problems.length, 0);

    const audit = await repo.getLedgerAudit();
    assert.strictEqual(audit.invariants.debitsEqualCredits, true);
    assert.strictEqual(audit.invariants.accountingEquationSatisfied, true);
  });
});
