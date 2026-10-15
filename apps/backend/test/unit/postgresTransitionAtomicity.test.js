'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresDatabaseRepository } = require('../../src/db/repository');

function createTransactionalPool() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT * FROM trips')) {
        return { rowCount: 1, rows: [{ id: 'trip-1', status: 'IN_TRANSIT', version: 4 }] };
      }
      if (sql.startsWith('UPDATE trips SET status')) {
        return { rowCount: 1, rows: [{ id: 'trip-1', status: params[0], version: 5 }] };
      }
      if (sql.startsWith('SELECT * FROM delivery_audit_logs')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.startsWith('INSERT INTO delivery_audit_logs')) {
        return { rowCount: 1, rows: [{ order_id: params[0], from_state: params[1], to_state: params[2], version: params[5] }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  return {
    calls,
    async withTransaction(work) {
      calls.push({ sql: 'BEGIN' });
      const result = await work(client);
      calls.push({ sql: 'COMMIT' });
      return result;
    }
  };
}

test('PostgreSQL trip transition uses one transaction client and records the real from_state', async () => {
  const pool = createTransactionalPool();
  const repository = new PostgresDatabaseRepository(pool);

  const result = await repository.transitionTripState(
    'trip-1',
    4,
    'DELIVERY_CONFIRMED',
    { type: 'DRIVER', id: 'driver-1' },
    'delivery complete',
    'idem-1',
    { source: 'test' }
  );

  assert.equal(result.success, true);
  assert.equal(result.trip.status, 'DELIVERY_CONFIRMED');
  assert.equal(result.trip.version, 5);
  assert.equal(result.auditLog.from_state, 'IN_TRANSIT');
  assert.equal(result.auditLog.to_state, 'DELIVERY_CONFIRMED');

  const transactionBoundary = pool.calls.map(call => call.sql);
  assert.equal(transactionBoundary[0], 'BEGIN');
  assert.equal(transactionBoundary.at(-1), 'COMMIT');
  assert.ok(transactionBoundary.includes('SELECT * FROM trips WHERE id = $1 FOR UPDATE'));
  assert.ok(transactionBoundary.some(sql => sql.startsWith('UPDATE trips SET status')));
  assert.ok(transactionBoundary.some(sql => sql.startsWith('INSERT INTO delivery_audit_logs')));
});
