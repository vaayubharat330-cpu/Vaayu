'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(
  path.join(__dirname, '../../src/db/migrations/007_kyc_license_owner_registry.sql'),
  'utf8',
);
const runner = fs.readFileSync(
  path.join(__dirname, '../../src/db/runLedgerMigrations.js'),
  'utf8',
);

test('KYC licence ownership uses a canonical single-owner registry', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS kyc_license_owners/);
  assert.match(migration, /license_number_hash VARCHAR\(64\) PRIMARY KEY/);
  assert.match(migration, /driver_id VARCHAR\(128\) NOT NULL/);
  assert.match(migration, /ON CONFLICT \(license_number_hash\) DO NOTHING/);
  assert.match(migration, /DRIVING_LICENSE_ALREADY_BOUND_TO_DRIVER/);
  assert.match(migration, /CREATE TRIGGER trg_kyc_license_owner/);
});

test('migration runner executes the licence owner registry migration', () => {
  assert.match(runner, /007_kyc_license_owner_registry\.sql/);
});
