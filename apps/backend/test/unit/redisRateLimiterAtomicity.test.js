'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RedisRateLimiter, RATE_LIMIT_SCRIPT } = require('../../src/services/redisRateLimiter');

function request(id = 'client-1') {
  return { user: { id }, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}

function responseHeaders() {
  const headers = {};
  return { headers, setHeader(name, value) { headers[name] = value; } };
}

test('rate limiter uses one atomic Redis script for increment and first expiry', () => {
  assert.match(RATE_LIMIT_SCRIPT, /redis\.call\('INCR'/);
  assert.match(RATE_LIMIT_SCRIPT, /redis\.call\('EXPIRE'/);
  assert.match(RATE_LIMIT_SCRIPT, /count == 1/);
  assert.match(RATE_LIMIT_SCRIPT, /redis\.call\('TTL'/);
});

test('rate limiter preserves bounded development fallback and quota semantics', async () => {
  const calls = [];
  let count = 0;
  const fakeRedis = {
    async eval() { throw new Error('EVAL_UNSUPPORTED_BY_MEMORY_ENGINE'); },
    async incr(key) { calls.push(['incr', key]); return ++count; },
    async expire(key, seconds) { calls.push(['expire', key, seconds]); return 1; },
    async disconnect() {}
  };
  const limiter = new RedisRateLimiter(fakeRedis);

  const first = responseHeaders();
  const allowed = await limiter.checkRateLimit(request(), first, 'test', 2, 30);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.current, 1);
  assert.equal(first.headers['X-RateLimit-Reset'], 30);

  const second = responseHeaders();
  const stillAllowed = await limiter.checkRateLimit(request(), second, 'test', 2, 30);
  assert.equal(stillAllowed.allowed, true);
  assert.equal(stillAllowed.current, 2);

  const third = responseHeaders();
  const over = await limiter.checkRateLimit(request(), third, 'test', 2, 30);
  assert.equal(over.allowed, false);
  assert.equal(over.code, 'RATE_LIMIT_EXCEEDED');
  assert.equal(calls.filter(call => call[0] === 'expire').length, 1);
});

test('custom zero limits are honored instead of falling back to route defaults', async () => {
  const fakeRedis = {
    async eval() { return [1, 10]; },
    async disconnect() {}
  };
  const limiter = new RedisRateLimiter(fakeRedis);
  const result = await limiter.checkRateLimit(request('zero-limit'), null, 'default', 0, 10);
  assert.equal(result.allowed, false);
  assert.equal(result.limit, 0);
});
