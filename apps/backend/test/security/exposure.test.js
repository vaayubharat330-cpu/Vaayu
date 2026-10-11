// Security regression tests for the exposure issues in PRODUCT_ISSUES.md (S1, S2, S3).
// These run against a live server (default http://127.0.0.1:4100, override with VAAYU_TEST_BASE).
// They only send requests that must be refused, so they do not change any data.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4100';

async function status(method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  return r.status;
}

// S1: driver location and nearby-driver data must not be public.
test('S1: nearby-drivers telemetry requires a signed-in user', async () => {
  assert.equal(await status('GET', '/api/telemetry/nearby-drivers?lat=17.44&lng=78.35&radius=10'), 401);
});

test('S1: drivers/nearby requires a signed-in user', async () => {
  assert.equal(await status('GET', '/api/drivers/nearby?lat=17.44&lng=78.35'), 401);
});

// S2: the trip-wipe endpoint must be refused for unauthenticated callers, even if the environment flag is set.
test('S2: reset-test is refused without a signed-in SUPER_ADMIN', async () => {
  const code = await status('POST', '/api/trips/reset-test', {});
  assert.ok(code === 401 || code === 403 || code === 404, `expected refusal, got ${code}`);
});

// S3: internal cache statistics must not be public. The vehicle catalogue stays public, because the driver app needs it before sign-in.
test('S3: routing cache statistics require a signed-in admin', async () => {
  assert.equal(await status('GET', '/api/routing/cache-stats'), 401);
});

test('S3: vehicle catalogue stays public for the driver app', async () => {
  assert.equal(await status('GET', '/api/vehicles'), 200);
});
