'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');

function repositoryWithTotals({ debit, credit, unbalancedEntries = [] }) {
  const pool = {
    async query(sql) {
      if (sql.includes('HAVING SUM')) return { rows: unbalancedEntries };
      if (sql.includes('WITH posting_totals')) return { rows: [] };
      if (sql.includes('COUNT(*) as count')) return { rows: [{ count: '2' }] };
      if (sql.includes('AS total_debits')) return { rows: [{ total_debits: debit, total_credits: credit }] };
      throw new Error(`Unexpected query in reconciliation test: ${sql}`);
    }
  };
  return new PostgresLedgerRepository(pool);
}

test('PostgreSQL reconciliation reports aggregate totals and parity', async () => {
  const result = await repositoryWithTotals({ debit: '35000', credit: '35000' }).reconcile();

  assert.equal(result.ok, true);
  assert.equal(result.balanced, true);
  assert.equal(result.journalEntriesCount, 2);
  assert.equal(result.totalDebitsPaise, 35000);
  assert.equal(result.totalCreditsPaise, 35000);
});

test('PostgreSQL reconciliation exposes aggregate imbalance and journal problems', async () => {
  const result = await repositoryWithTotals({
    debit: '35000',
    credit: '34000',
    unbalancedEntries: [{ entry_id: 'JE-1', debits: '35000', credits: '34000' }]
  }).reconcile();

  assert.equal(result.ok, false);
  assert.equal(result.balanced, false);
  assert.equal(result.totalDebitsPaise, 35000);
  assert.equal(result.totalCreditsPaise, 34000);
  assert.match(result.problems[0], /Unbalanced journal JE-1/);
});
