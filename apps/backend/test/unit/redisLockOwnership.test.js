'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RedisLockManager } = require('../../src/services/redisLockManager');
const { RedisClient, sharedMemoryRedisEngine } = require('../../src/services/redisClient');

test('Redis lock ownership: stale owner cannot release a newer lock', async () => {
  sharedMemoryRedisEngine.clear();
  const client = new RedisClient();
  const locks = new RedisLockManager(client);

  const first = await locks.acquireTripLock('trip-lock-test', 1000);
  assert.equal(first.success, true);

  const key = first.key;
  await client.del(key);
  const second = await locks.acquireTripLock('trip-lock-test', 1000);
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
  sharedMemoryRedisEngine.clear();
  const client = new RedisClient();
  const locks = new RedisLockManager(client);

  const owner = await locks.acquireScopedLock('test-lock:', 'refresh', 1000);
  assert.equal(owner.success, true);

  const rejected = await locks._compareAndSet(owner.key, 'wrong-owner', 'replacement', 5000);
  assert.equal(rejected, false);
  assert.equal(await client.get(owner.key), owner.token);

  const refreshed = await locks._compareAndSet(owner.key, owner.token, 'refreshed-owner', 5000);
  assert.equal(refreshed, true);
  assert.equal(await client.get(owner.key), 'refreshed-owner');

  await locks.releaseScopedLock({ key: owner.key, token: 'refreshed-owner' });
});
