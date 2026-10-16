'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RedisLockManager } = require('../../src/services/redisLockManager');
const { RedisClient } = require('../../src/services/redisClient');

const testClients = new Set();

function uniqueLockName(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createTestLocks() {
  const client = new RedisClient();
  testClients.add(client);
  return { client, locks: new RedisLockManager(client) };
}

test.afterEach(async () => {
  const clients = Array.from(testClients);
  testClients.clear();
  await Promise.all(clients.map(client => client.disconnect()));
});

test('Redis lock ownership: stale owner cannot release a newer lock', async () => {
  const { client, locks } = createTestLocks();
  const lockName = uniqueLockName('trip-lock-test');

  const first = await locks.acquireTripLock(lockName, 1000);
  assert.equal(first.success, true);

  const key = first.key;
  await client.del(key);
  const second = await locks.acquireTripLock(lockName, 1000);
  assert.equal(second.success, true);
  assert.notEqual(first.token, second.token);

  const staleRelease = await locks.releaseTripLock(first);
  assert.equal(staleRelease, false);
  assert.equal(await client.get(key), second.token);

  const validRelease = await locks.releaseTripLock(second);
  assert.equal(validRelease, true);
  assert.equal(await client.get(key), null);
});

test('Redis lock ownership: refresh rejects a different reservation and preserves owner', async () => {
  const { client, locks } = createTestLocks();
  const lockName = uniqueLockName('refresh');

  const owner = await locks.acquireScopedLock('test-lock:', lockName, 1000);
  assert.equal(owner.success, true);

  const rejected = await locks._compareAndSet(owner.key, 'wrong-owner', 'replacement', 5000);
  assert.equal(rejected, false);
  assert.equal(await client.get(owner.key), owner.token);

  const refreshed = await locks._compareAndSet(owner.key, owner.token, 'refreshed-owner', 5000);
  assert.equal(refreshed, true);
  assert.equal(await client.get(owner.key), 'refreshed-owner');

  await locks.releaseScopedLock({ key: owner.key, token: 'refreshed-owner' });
});

test('Redis lock ownership: scoped lease refresh extends only the current owner', async () => {
  const { client, locks } = createTestLocks();
  const lockName = uniqueLockName('lease-refresh');

  const owner = await locks.acquireIdempotencyLock(lockName, 1000);
  assert.equal(owner.success, true);
  const before = owner.expiresAt;

  const refreshed = await locks.refreshIdempotencyLock(owner, 5000);
  assert.equal(refreshed.success, true);
  assert.ok(refreshed.expiresAt > before);
  assert.equal(await client.get(owner.key), owner.token);

  const stale = { ...owner, token: 'stale-owner-token' };
  const rejected = await locks.refreshIdempotencyLock(stale, 5000);
  assert.equal(rejected.success, false);
  assert.equal(await client.get(owner.key), owner.token);

  await locks.releaseIdempotencyLock(owner);
});
