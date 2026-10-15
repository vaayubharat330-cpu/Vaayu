'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IdempotencyService } = require('../../src/services/idempotencyService');
const { redisLockManager } = require('../../src/services/redisLockManager');

function uniqueKey(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('idempotency abort lifecycle releases the distributed command lease', async () => {
  const service = new IdempotencyService();
  const key = uniqueKey('idempotency-abort');

  const acquired = await redisLockManager.acquireIdempotencyLock(key, 5000);
  assert.equal(acquired.success, true);
  service._trackPendingLock(key, acquired);

  assert.equal(await redisLockManager.redis.get(acquired.key), acquired.token);
  const released = await service.abortResponse(key);
  assert.equal(released, true);
  assert.equal(await redisLockManager.redis.get(acquired.key), null);
  assert.equal(service.pendingLocks.has(key), false);
});

test('idempotency abort lifecycle is a no-op after the command was finalized', async () => {
  const service = new IdempotencyService();
  const key = uniqueKey('idempotency-finalized');

  const acquired = await redisLockManager.acquireIdempotencyLock(key, 5000);
  assert.equal(acquired.success, true);
  service._trackPendingLock(key, acquired);
  service._takePendingLock(key);

  assert.equal(await service.abortResponse(key), false);
  await redisLockManager.releaseIdempotencyLock(acquired);
});
