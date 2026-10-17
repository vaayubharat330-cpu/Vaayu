'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');

const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { runMigrations } = require('../../src/db/runLedgerMigrations');

test('Wallet top-up idempotency: concurrent retries converge to one ledger mutation', async (t) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip('Skipping wallet top-up idempotency test: DATABASE_ADMIN_URL/DATABASE_URL not configured.');
    return;
  }

  await runMigrations();

  const pool = new PostgresPool({ connectionString, max: 30, connectionTimeoutMillis: 15000 });
  const repo = new PostgresLedgerRepository(pool);
  const customerId = `TOPUP_IDEMP_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const idempotencyKey = `TOPUP_REPLAY_${customerId}`;
  const amountPaise = 12500;

  t.after(async () => {
    await pool.end();
  });

  const results = await Promise.all(
    Array.from({ length: 25 }, () => repo.topUpCustomerWallet({
      customerId,
      amountPaise,
      idempotencyKey
    }))
  );

  const initialMutations = results.filter(result => result.idempotentReplay === false);
  const replays = results.filter(result => result.idempotentReplay === true);

  assert.equal(results.length, 25);
  assert.equal(initialMutations.length, 1, 'Exactly one concurrent caller may perform the financial mutation');
  assert.equal(replays.length, 24, 'Every concurrent retry must converge to an idempotent replay');
  assert.ok(results.every(result => result.success === true));
  assert.ok(results.every(result => result.amountPaise === amountPaise));
  assert.ok(results.every(result => result.customerBalance.paise === amountPaise));

  const entries = await pool.query(
    'SELECT entry_id, reference_id, idempotency_key FROM ledger_journal_entries WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  assert.equal(entries.rows.length, 1, 'Only one immutable journal entry may exist for the idempotency key');
  assert.equal(entries.rows[0].reference_id, `TOPUP_${customerId}_${idempotencyKey}`);

  const idempotencyRows = await pool.query(
    'SELECT request_hash, entry_id FROM ledger_idempotency WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  assert.equal(idempotencyRows.rows.length, 1, 'Exactly one durable idempotency record must exist');
  assert.equal(idempotencyRows.rows[0].entry_id, entries.rows[0].entry_id);

  const balance = await repo.getCustomerBalance(customerId);
  assert.equal(balance.paise, amountPaise, 'Concurrent retries must never multiply the wallet balance');
});
