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

test('idempotency response is deferred when settlement or refund is still pending', async () => {
  const service = new IdempotencyService();
  const key = uniqueKey('idempotency-payment-pending');
  const acquired = await redisLockManager.acquireIdempotencyLock(key, 5000);
  assert.equal(acquired.success, true);
  service._trackPendingLock(key, acquired);

  await service.saveResponse(key, 'TRIP-PENDING', 200, {
    success: true,
    paymentSettlement: { success: false, error: { code: 'LEDGER_UNAVAILABLE' } }
  });

  assert.equal(await redisLockManager.redis.get(acquired.key), null);
  assert.equal(service.pendingLocks.has(key), false);
  assert.equal(service.memoryCache.has(key), false);

  const secondKey = uniqueKey('idempotency-refund-pending');
  const second = await redisLockManager.acquireIdempotencyLock(secondKey, 5000);
  assert.equal(second.success, true);
  service._trackPendingLock(secondKey, second);

  await service.saveResponse(secondKey, 'TRIP-REFUND-PENDING', 200, {
    success: true,
    paymentRefund: { success: false, error: { code: 'PROVIDER_UNAVAILABLE' } }
  });

  assert.equal(await redisLockManager.redis.get(second.key), null);
  assert.equal(service.pendingLocks.has(secondKey), false);
  assert.equal(service.memoryCache.has(secondKey), false);
});
