'use strict';

/**
 * VAAYU Phase P.1: Database Disaster Recovery (DR) & Point-In-Time Certification Suite
 *
 * Verifies:
 * 1. pg_dump Cold/Warm Snapshot Creation
 * 2. Fresh Database Provisioning & psql Stream Restore
 * 3. 12-Point Comprehensive Invariant Verification:
 *    - ledger_journal_entries intact
 *    - ledger_postings intact
 *    - Every journal entry balanced (debits == credits)
 *    - Materialized balances == computed sum of postings
 *    - System-wide debits == credits
 *    - Payment state consistent
 *    - Idempotency registry intact
 *    - Transactional outbox intact
 *    - Provider events intact
 *    - Discrepancy & financial audit trail intact
 * 4. Recovery Write Test (Validates restored engine accepts mutations)
 * 5. Post-Recovery Authoritative SQL Reconciliation (Zero Unexplained Imbalance)
 * 6. Point-In-Time (PITR) Sequence & Snapshot Repeatability
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { DatabaseDisasterRecoveryManager } = require('../../src/db/databaseDisasterRecovery');

test('VAAYU Operational Certification: Pillar 1 Database Disaster Recovery Suite', async (t) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip('Skipping DR certification: DATABASE_ADMIN_URL not configured.');
    return;
  }

  const drManager = new DatabaseDisasterRecoveryManager({ adminUrl: connectionString });
  const pool = new PostgresPool({ connectionString });
  const repo = new PostgresLedgerRepository(pool);

  t.after(async () => {
    await pool.end();
  });

  await t.test('1. Production Snapshot Creation: pg_dump Completes With Zero Errors', async () => {
    const backup = await drManager.createBackup({ tag: 'unit_p1' });
    assert.ok(backup.backupPath, 'Backup file path must be defined');
    assert.ok(backup.sizeBytes > 0, `Backup size must be positive, got ${backup.sizeBytes} bytes`);
  });

  await t.test('2. Ephemeral Target Restore & 12-Point Financial Invariant Certification', async () => {
    const targetDbName = `vaayu_dr_test_${Date.now()}`;
    const report = await drManager.executeFullDisasterRecoveryTest({ targetDbName });

    // Verify all steps completed
    const stepNames = report.steps.map(s => s.step);
    assert.ok(stepNames.includes('BACKUP_CREATED'));
    assert.ok(stepNames.includes('TARGET_DB_PROVISIONED'));
    assert.ok(stepNames.includes('RESTORE_COMPLETED'));

    // Check invariants
    const inv = report.invariants;
    assert.strictEqual(inv.everyJournalBalanced, true, 'Every journal entry must be balanced (debits === credits)');
    assert.strictEqual(inv.unbalancedJournalEntries, 0, 'Zero unbalanced journal entries allowed');
    assert.strictEqual(inv.reconciliationOk, true, `Reconciliation must pass: ${inv.reconciliationProblems.join(', ')}`);
    assert.strictEqual(inv.systemDebitsEqualCredits, true, 'System-wide debits must equal credits');
    assert.strictEqual(inv.paymentStateConsistent, true, 'Payment states must remain strictly valid');
    assert.strictEqual(inv.recoveryWriteSuccess, true, 'Restored database must accept new mutations');
    assert.strictEqual(inv.postRecoveryReconciliationOk, true, 'Reconciliation must hold after recovery writes');

    assert.strictEqual(report.isCertified, true, 'Complete Disaster Recovery Certification must pass');
  });

  await t.test('3. Timeline & Point-in-Time State Reconstruction (Snapshot Repeatability)', async () => {
    // Generate an isolated snapshot state with a tagged ledger transaction
    const snapTripId = `TRIP_PITR_${Date.now()}`;
    const custId = `CUST_PITR_${Date.now()}`;
    const farePaise = 45000;

    await repo.topUpCustomerWallet({
      customerId: custId,
      amountPaise: farePaise,
      idempotencyKey: `TOPUP_${snapTripId}`
    });

    await repo.reserveEscrow({
      tripId: snapTripId,
      customerId: custId,
      amountPaise: farePaise,
      idempotencyKey: `ESCROW_${snapTripId}`
    });

    // Capture point-in-time snapshot immediately after escrow
    const pitrBackup = await drManager.createBackup({ tag: 'pitr_checkpoint' });
    assert.ok(pitrBackup.sizeBytes > 0);

    // Simulate post-snapshot operational mutation on source database (e.g. settlement)
    const driverId = `DRV_PITR_${Date.now()}`;
    await repo.settleTrip({
      tripId: snapTripId,
      driverId,
      commissionBps: 1000,
      gstBps: 1800,
      idempotencyKey: `SETTLE_${snapTripId}`
    });

    // Check source state is now SETTLED
    const sourceTx = await repo.getPaymentByTripId(snapTripId);
    assert.strictEqual(sourceTx.state, 'SETTLED');

    // Restore the point-in-time checkpoint to a temporary target database
    const pitrTargetDb = `vaayu_pitr_target_${Date.now()}`;
    const adminPool = new PostgresPool({ connectionString });

    try {
      await adminPool.query(`CREATE DATABASE ${pitrTargetDb};`);
      const restoreArgs = [
        '-h', drManager.dbHost,
        '-p', drManager.dbPort,
        '-U', drManager.dbUser,
        '-d', pitrTargetDb,
        '-f', pitrBackup.backupPath
      ];
      const { execFileSync } = require('child_process');
      execFileSync(drManager.psqlPath, restoreArgs, { env: drManager._getEnv(), stdio: 'pipe' });

      // Connect to the restored PITR target database
      const pitrUrl = new URL(connectionString);
      pitrUrl.pathname = `/${pitrTargetDb}`;
      const pitrPool = new PostgresPool({ connectionString: pitrUrl.toString() });
      const pitrRepo = new PostgresLedgerRepository(pitrPool);

      try {
        // Assert the recovered state is EXACTLY the state at snapshot time (ESCROWED, not SETTLED)
        const recoveredTx = await pitrRepo.getPaymentByTripId(snapTripId);
        assert.strictEqual(recoveredTx.state, 'ESCROWED', 'Recovered state must match the snapshot point in time (ESCROWED)');
        assert.strictEqual(recoveredTx.escrowPaise, farePaise);

        // Assert full reconciliation on the point-in-time recovered state
        const recon = await pitrRepo.reconcile();
        assert.strictEqual(recon.ok, true, 'PITR restored database must be mathematically reconciled');
      } finally {
        await pitrPool.end();
      }
    } finally {
      await adminPool.query(`DROP DATABASE IF EXISTS ${pitrTargetDb};`);
      await adminPool.end();
    }
  });
});
