'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  DatabaseDisasterRecoveryManager,
  validateDatabaseIdentifier,
  validateBackupTag,
  sha256File
} = require('../../src/db/databaseDisasterRecovery');

test('DR policy rejects unsafe PostgreSQL identifiers', () => {
  assert.equal(validateDatabaseIdentifier('vaayu_dr_test_123'), 'vaayu_dr_test_123');
  assert.throws(() => validateDatabaseIdentifier('vaayu; DROP DATABASE vaayu'), /Invalid database name/);
  assert.throws(() => validateDatabaseIdentifier('../escape'), /Invalid database name/);
  assert.throws(() => validateDatabaseIdentifier('123bad'), /Invalid database name/);
});

test('DR policy rejects backup path traversal tags', () => {
  assert.equal(validateBackupTag('nightly_01'), 'nightly_01');
  assert.throws(() => validateBackupTag('../nightly'), /Invalid backup tag/);
  assert.throws(() => validateBackupTag('nightly/report'), /Invalid backup tag/);
});

test('DR backup digest detects tampering and only accepts files in backup directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-dr-'));
  const backup = path.join(dir, 'backup.sql');
  const outsideBackup = path.join(path.dirname(dir), `${path.basename(dir)}-outside.sql`);
  fs.writeFileSync(backup, 'CREATE TABLE proof(id integer);');
  fs.writeFileSync(outsideBackup, 'CREATE TABLE outside(id integer);');
  const digest = sha256File(backup);
  const manager = new DatabaseDisasterRecoveryManager({
    adminUrl: 'postgresql://user:pass@127.0.0.1:5432/vaayu',
    pgDumpPath: process.execPath,
    psqlPath: process.execPath,
    backupDir: dir
  });

  assert.equal(manager.verifyBackup(backup, digest), true);
  fs.appendFileSync(backup, '\n-- tampered');
  assert.equal(manager.verifyBackup(backup, digest), false);
  assert.throws(() => manager.verifyBackup(outsideBackup, digest), /Backup path must be inside/);
  assert.equal(digest.length, crypto.createHash('sha256').digest().length * 2);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outsideBackup, { force: true });
});
