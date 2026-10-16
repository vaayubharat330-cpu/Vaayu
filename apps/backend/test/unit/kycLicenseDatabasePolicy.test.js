'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(
  path.join(__dirname, '../../src/db/migrations/006_fix_kyc_license_reuse.sql'),
  'utf8'
);

test('KYC database policy allows the same driver to reuse a driving licence', () => {
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_license_owner[\s\S]*?ON driver_kyc_documents\(license_number_hash, driver_id\)/);
  assert.doesNotMatch(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_license_owner[\s\S]*?ON driver_kyc_documents\(license_number_hash\)/
  );
});

test('KYC database policy retains global lookup for licence ownership conflicts', () => {
  assert.match(migration, /idx_kyc_license_lookup/);
  assert.match(migration, /ON driver_kyc_documents\(license_number_hash\)/);
});
