'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(
  path.join(__dirname, '../../src/db/migrations/006_fix_kyc_license_reuse.sql'),
  'utf8'
);

function getCreateIndexStatement(indexName) {
  const prefix = `CREATE UNIQUE INDEX IF NOT EXISTS ${indexName}`;
  const start = migration.indexOf(prefix);
  assert.notEqual(start, -1, `missing ${indexName} definition`);

  const end = migration.indexOf(';', start);
  assert.notEqual(end, -1, `unterminated ${indexName} definition`);

  return migration.slice(start, end + 1);
}

test('KYC database policy allows the same driver to reuse a driving licence', () => {
  const ownerIndex = getCreateIndexStatement('uq_kyc_license_owner');

  assert.ok(
    ownerIndex.includes('ON driver_kyc_documents(license_number_hash, driver_id)'),
    'owner index must be scoped by both licence hash and driver'
  );
  assert.ok(
    !ownerIndex.includes('ON driver_kyc_documents(license_number_hash)'),
    'owner index must not be globally unique by licence hash'
  );
});

test('KYC database policy retains global lookup for licence ownership conflicts', () => {
  assert.ok(migration.includes('CREATE INDEX IF NOT EXISTS idx_kyc_license_lookup'));
  assert.ok(migration.includes('ON driver_kyc_documents(license_number_hash)'));
});
