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
    if (typeof backupPath !== 'string') {
      throw new Error('Backup path must be inside the configured backup directory.');
    }

    const configuredDir = path.resolve(this.backupDir);
    const candidatePath = path.resolve(backupPath);
    if (path.dirname(candidatePath) !== configuredDir) {
      throw new Error('Backup path must be inside the configured backup directory.');
    }
    if (!fs.existsSync(candidatePath)) throw new Error(`Backup file does not exist: ${backupPath}`);

    // Resolve the actual filesystem target as well as the lexical path. A symlink
    // placed inside the backup directory must not be allowed to verify or restore a
    // file that lives outside the trusted directory.
    let realBackupPath;
    let realBackupDir;
    try {
      realBackupPath = fs.realpathSync(candidatePath);
      realBackupDir = fs.realpathSync(configuredDir);
    } catch (_) {
      throw new Error('Backup path could not be resolved safely.');
    }
    if (path.dirname(realBackupPath) !== realBackupDir) {
      throw new Error('Backup path must resolve inside the configured backup directory.');
    }

    if (!/^[a-f0-9]{64}$/.test(String(expectedSha256))) throw new Error('Invalid backup SHA-256 digest.');
    const actual = sha256File(candidatePath);
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
      if (!this.verifyBackup(dumpFilePath, sha256)) throw new Error('Backup integrity verification failed immediately after creation.');
      return { backupPath: dumpFilePath, sizeBytes: stats.size, sha256 };
    } catch (error) {
      try { if (fs.existsSync(dumpFilePath)) fs.rmSync(dumpFilePath, { force: true }); } catch (_) {}
      throw error;
    }
  }

  async restoreBackup({ backupPath, expectedSha256, targetDbName = `${this.sourceDbName}_dr_restore` } = {}) {
    validateDatabaseIdentifier(targetDbName, 'target database name');
    if (!this.verifyBackup(backupPath, expectedSha256)) throw new Error('Backup integrity verification failed.');

    const adminPool = new PostgresPool(this.adminUrl.replace(/\/[^/]*$/, '/postgres'));
    let targetPool = null;
    const report = { success: false, steps: [] };

    try {
      await adminPool.query(`DROP DATABASE IF EXISTS \"${targetDbName}\";`);
      await adminPool.query(`CREATE DATABASE \"${targetDbName}\";`);
      report.steps.push({ step: 'TARGET_DB_PROVISIONED', database: targetDbName });

      const targetUrl = this.adminUrl.replace(/\/[^/]*$/, `/${targetDbName}`);
      targetPool = new PostgresPool(targetUrl);
      execFileSync(this.psqlPath, ['-h', this.dbHost, '-p', this.dbPort, '-U', this.dbUser, '-d', targetDbName, '-f', backupPath], { env: this._getEnv(), stdio: 'pipe' });
      report.steps.push({ step: 'BACKUP_RESTORED', path: backupPath });

      const ledger = new PostgresLedgerRepository(targetPool);
      const reconciliation = await ledger.reconcile();
      report.reconciliation = reconciliation;
      report.success = reconciliation.ok === true;
      report.steps.push({ step: 'LEDGER_RECONCILED', ok: reconciliation.ok, problems: reconciliation.problems.length });
      return report;
    } finally {
      if (targetPool) await targetPool.end().catch(() => {});
      await adminPool.query(`DROP DATABASE IF EXISTS \"${targetDbName}\";`).catch(() => {});
      await adminPool.end().catch(() => {});
    }
  }
}

module.exports = {
  DatabaseDisasterRecoveryManager,
  validateDatabaseIdentifier,
  validateBackupTag,
  sha256File
};
