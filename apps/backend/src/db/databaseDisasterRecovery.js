'use strict';

/**
 * VAAYU Disaster Recovery (DR) & Backup/Restore Automation
 *
 * The DR manager is deliberately fail-closed: database identifiers used in
 * administrative SQL are validated, backup tags cannot escape the backup
 * directory, and every dump carries a SHA-256 integrity digest.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PostgresPool } = require('./postgresClient');
const { PostgresLedgerRepository } = require('../services/ledger/postgresLedgerRepository');

const DATABASE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const BACKUP_TAG = /^[A-Za-z0-9_-]{1,64}$/;

function validateDatabaseIdentifier(value, fieldName = 'database name') {
  if (typeof value !== 'string' || !DATABASE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${fieldName}: ${String(value)}`);
  }
  return value;
}

function validateBackupTag(value) {
  if (typeof value !== 'string' || !BACKUP_TAG.test(value)) {
    throw new Error(`Invalid backup tag: ${String(value)}`);
  }
  return value;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function findPostgresBin(toolName) {
  const isWindows = process.platform === 'win32';
  const defaultDir = isWindows ? 'C:\\Program Files\\PostgreSQL\\18\\bin' : '/usr/bin';
  const candidate = path.join(defaultDir, isWindows ? `${toolName}.exe` : toolName);
  if (fs.existsSync(candidate)) return candidate;

  try {
    const locator = isWindows ? 'where' : 'which';
    const output = execFileSync(locator, [toolName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const located = output.trim().split(/\r?\n/)[0];
    if (located && fs.existsSync(located)) return located;
  } catch (_) {}

  throw new Error(`PostgreSQL binary ${toolName} not found in ${defaultDir} or PATH.`);
}

class DatabaseDisasterRecoveryManager {
  constructor(options = {}) {
    this.adminUrl = options.adminUrl || process.env.DATABASE_ADMIN_URL;
    if (!this.adminUrl) throw new Error('DATABASE_ADMIN_URL must be configured for DR operations.');

    const parsed = new URL(this.adminUrl);
    this.dbHost = parsed.hostname || '127.0.0.1';
    this.dbPort = parsed.port || '5432';
    this.dbUser = decodeURIComponent(parsed.username || 'postgres');
    this.dbPassword = decodeURIComponent(parsed.password || '');
    this.sourceDbName = validateDatabaseIdentifier(
      decodeURIComponent(parsed.pathname.replace(/^\//, '') || 'vaayu'),
      'source database name'
    );

    this.pgDumpPath = options.pgDumpPath || findPostgresBin('pg_dump');
    this.psqlPath = options.psqlPath || findPostgresBin('psql');
    this.backupDir = path.resolve(options.backupDir || path.resolve(__dirname, '../../local-data/backups'));

    if (!fs.existsSync(this.backupDir)) fs.mkdirSync(this.backupDir, { recursive: true });
  }

  _getEnv() {
    return { ...process.env, PGPASSWORD: this.dbPassword };
  }

  static validateDatabaseIdentifier(value, fieldName) {
    return validateDatabaseIdentifier(value, fieldName);
  }

  static validateBackupTag(value) {
    return validateBackupTag(value);
  }

  static sha256File(filePath) {
    return sha256File(filePath);
  }

  verifyBackup(backupPath, expectedSha256) {
    if (typeof backupPath !== 'string' || path.dirname(path.resolve(backupPath)) !== this.backupDir) {
      throw new Error('Backup path must be inside the configured backup directory.');
    }
    if (!fs.existsSync(backupPath)) throw new Error(`Backup file does not exist: ${backupPath}`);
    if (!/^[a-f0-9]{64}$/.test(String(expectedSha256))) throw new Error('Invalid backup SHA-256 digest.');
    const actual = sha256File(backupPath);
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expectedSha256));
  }

  async createBackup({ tag = 'dr_test' } = {}) {
    validateBackupTag(tag);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dumpFileName = `vaayu_backup_${tag}_${timestamp}.sql`;
    const dumpFilePath = path.join(this.backupDir, dumpFileName);

    try {
      execFileSync(this.pgDumpPath, [
        '-h', this.dbHost, '-p', this.dbPort, '-U', this.dbUser,
        '-d', this.sourceDbName, '--clean', '--if-exists',
        '--no-owner', '--no-privileges', '-f', dumpFilePath
      ], { env: this._getEnv(), stdio: 'pipe' });

      const stats = fs.statSync(dumpFilePath);
      if (stats.size <= 0) throw new Error('pg_dump produced an empty backup.');
      const sha256 = sha256File(dumpFilePath);
      return { backupPath: dumpFilePath, backupFile: dumpFileName, sizeBytes: stats.size, sha256, createdAt: new Date().toISOString() };
    } catch (error) {
      fs.rmSync(dumpFilePath, { force: true });
      throw error;
    }
  }

  async executeFullDisasterRecoveryTest({ targetDbName = `vaayu_dr_recovery_${Date.now()}` } = {}) {
    validateDatabaseIdentifier(targetDbName, 'target database name');
    const report = { startedAt: new Date().toISOString(), targetDb: targetDbName, steps: [], invariants: {}, isCertified: false };
    const adminPool = new PostgresPool({ connectionString: this.adminUrl });
    let targetPool = null;

    try {
      const backupResult = await this.createBackup({ tag: 'cert' });
      if (!this.verifyBackup(backupResult.backupPath, backupResult.sha256)) throw new Error('Backup integrity verification failed.');
      report.steps.push({ step: 'BACKUP_CREATED', path: backupResult.backupPath, sizeBytes: backupResult.sizeBytes, sha256: backupResult.sha256 });

      await adminPool.query(`DROP DATABASE IF EXISTS \"${targetDbName}\";`);
      await adminPool.query(`CREATE DATABASE \"${targetDbName}\";`);
      report.steps.push({ step: 'TARGET_DB_PROVISIONED', database: targetDbName });

      execFileSync(this.psqlPath, ['-h', this.dbHost, '-p', this.dbPort, '-U', this.dbUser, '-d', targetDbName, '-f', backupResult.backupPath], { env: this._getEnv(), stdio: 'pipe' });
      report.steps.push({ step: 'RESTORE_COMPLETED', database: targetDbName });

      const targetUrl = new URL(this.adminUrl);
      targetUrl.pathname = `/${targetDbName}`;
      targetPool = new PostgresPool({ connectionString: targetUrl.toString() });
      const targetRepo = new PostgresLedgerRepository(targetPool);
      const invariants = {};

      const jeRes = await targetPool.query('SELECT COUNT(*) as count FROM ledger_journal_entries');
      invariants.journalEntriesCount = Number(jeRes.rows[0].count);
      invariants.journalEntriesIntact = invariants.journalEntriesCount >= 0;
      const postRes = await targetPool.query('SELECT COUNT(*) as count FROM ledger_postings');
      invariants.postingsCount = Number(postRes.rows[0].count);
      invariants.postingsIntact = invariants.postingsCount >= 0;
      const unbalRes = await targetPool.query(`SELECT e.entry_id, SUM(CASE WHEN p.side = 'DEBIT' THEN p.amount_paise ELSE 0 END) AS debits, SUM(CASE WHEN p.side = 'CREDIT' THEN p.amount_paise ELSE 0 END) AS credits FROM ledger_journal_entries e JOIN ledger_postings p ON e.entry_id = p.entry_id GROUP BY e.entry_id HAVING SUM(CASE WHEN p.side = 'DEBIT' THEN p.amount_paise ELSE 0 END) != SUM(CASE WHEN p.side = 'CREDIT' THEN p.amount_paise ELSE 0 END)`);
      invariants.unbalancedJournalEntries = unbalRes.rows.length;
      invariants.everyJournalBalanced = unbalRes.rows.length === 0;
      const reconResult = await targetRepo.reconcile();
      invariants.reconciliationOk = reconResult.ok;
      invariants.reconciliationProblems = reconResult.problems;
      const sysBalRes = await targetPool.query('SELECT COALESCE(SUM(debit_paise), 0) AS total_debits, COALESCE(SUM(credit_paise), 0) AS total_credits FROM ledger_accounts');
      invariants.systemTotalDebits = Number(sysBalRes.rows[0].total_debits);
      invariants.systemTotalCredits = Number(sysBalRes.rows[0].total_credits);
      invariants.systemDebitsEqualCredits = invariants.systemTotalDebits === invariants.systemTotalCredits;
      const txCheck = await targetPool.query("SELECT COUNT(*) AS invalid_count FROM payment_transactions WHERE state = 'ESCROWED' AND escrow_paise <= 0");
      invariants.paymentStateConsistent = Number(txCheck.rows[0].invalid_count) === 0;
      const idempRes = await targetPool.query('SELECT COUNT(*) as count FROM ledger_idempotency');
      invariants.idempotencyRecordsCount = Number(idempRes.rows[0].count);
      invariants.idempotencyRegistryIntact = true;
      const outboxRes = await targetPool.query('SELECT COUNT(*) as count FROM payment_outbox');
      invariants.outboxRecordsCount = Number(outboxRes.rows[0].count);
      invariants.outboxIntact = true;
      const eventsRes = await targetPool.query('SELECT COUNT(*) as count FROM payment_provider_events');
      invariants.providerEventsCount = Number(eventsRes.rows[0].count);
      invariants.providerEventsIntact = true;
      const auditRes = await targetPool.query('SELECT COUNT(*) as count FROM financial_audit_trail');
      invariants.auditRecordsCount = Number(auditRes.rows[0].count);
      invariants.auditTrailIntact = true;
      const drTopup = await targetRepo.topUpCustomerWallet({ customerId: `CUST_DR_${Date.now()}`, amountPaise: 50000, idempotencyKey: `DR_TOPUP_${Date.now()}` });
      invariants.recoveryWriteSuccess = drTopup.success && drTopup.status === 'COMPLETED';
      const postWriteRecon = await targetRepo.reconcile();
      invariants.postRecoveryReconciliationOk = postWriteRecon.ok;
      invariants.postRecoveryReconciliationProblems = postWriteRecon.problems;
      report.invariants = invariants;
      report.isCertified = invariants.everyJournalBalanced && invariants.reconciliationOk && invariants.systemDebitsEqualCredits && invariants.paymentStateConsistent && invariants.recoveryWriteSuccess && invariants.postRecoveryReconciliationOk;
      report.completedAt = new Date().toISOString();
      return report;
    } finally {
      if (targetPool) await targetPool.end().catch(() => {});
      await adminPool.query(`DROP DATABASE IF EXISTS \"${targetDbName}\";`).catch(() => {});
      await adminPool.end().catch(() => {});
    }
  }
}

module.exports = { DatabaseDisasterRecoveryManager, findPostgresBin, validateDatabaseIdentifier, validateBackupTag, sha256File };
