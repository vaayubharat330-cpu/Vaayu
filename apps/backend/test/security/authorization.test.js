// Authorization regression tests for PRODUCT_ISSUES.md S4 to S7, run against a live server.
// Default base http://127.0.0.1:4100 (override with VAAYU_TEST_BASE). Only refused or read-only requests
// are sent, so no state changes. Tokens are minted from the server's own JWT secret in the environment.
//
// Requires: VAAYU_TEST_JWT_SECRET (same value the server uses) so the test can mint tokens for specific
// users and roles without creating accounts. Skipped when absent, and reported as skipped, not passed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require(path.join(__dirname, '..', '..', 'node_modules', 'jsonwebtoken'));

const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4100';
const secret = process.env.VAAYU_TEST_JWT_SECRET || '';
const skip = secret.length < 32 ? 'VAAYU_TEST_JWT_SECRET not set (needs the server JWT secret)' : false;

function token(user) {
  return jwt.sign({ id: user.id, name: 'test', phone: '', role: user.role, city: 'Hyderabad' }, secret, { algorithm: 'HS256', expiresIn: 300 });
}

async function call(method, path, { bearer, body } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

// S4a: a driver must not be authorised for a trip just because their ID is a substring of another ID.
test('S4a: driver ID substring does not grant access to another driver trip', { skip }, async () => {
  const attacker = token({ id: 'drv_prof_1', role: 'DRIVER' });
  const r = await call('POST', '/api/orders/confirm-pickup', { bearer: attacker, body: { orderId: 'TRIP_does_not_exist_for_substring_test', otp: '0000' } });
  assert.notEqual(r.status, 200, 'a DRIVER must not reach a successful OTP verify on a trip they do not own');
});

// S4b: a customer must not be authorised for a trip by a shared ID suffix.
test('S4b: customer ID suffix match does not grant access to another customer trip', { skip }, async () => {
  const attacker = token({ id: 'usr_cust_1234', role: 'CUSTOMER' });
  const r = await call('GET', '/api/trips/TRIP_nonexistent_suffix_test', { bearer: attacker });
  assert.ok([403, 404].includes(r.status), `expected 403 or 404, got ${r.status}`);
});

// S5: a customer must not be able to move an order into a driver-only state.
test('S5: customer cannot perform a driver-only transition', { skip }, async () => {
  const customer = token({ id: 'usr_cust_s5test', role: 'CUSTOMER' });
  const r = await call('POST', '/api/orders/transition', { bearer: customer, body: { orderId: 'TRIP_nonexistent_s5', nextState: 'DELIVERED' } });
  assert.ok(r.status >= 400, `customer transition must be refused, got ${r.status}`);
});

// S6: a route not in the role map must not default to broad admin access.
test('S6: an admin route defaults to the most restrictive role set, not broad admin', { skip }, async () => {
  const fleetAdmin = token({ id: 'fleet_s6test', role: 'FLEET_ADMIN' });
  const r = await call('GET', '/api/admin/settings', { bearer: fleetAdmin });
  assert.ok([401, 403].includes(r.status), `FLEET_ADMIN must not read settings, got ${r.status}`);
});

// S6 (unknown route): an unmapped /api/admin/ path must refuse roles that are not explicitly granted it.
test('S6: unmapped /api/admin/ path refuses SUPPORT_AGENT', { skip }, async () => {
  const support = token({ id: 'sup_s6test', role: 'SUPPORT_AGENT' });
  const r = await call('GET', '/api/admin/zones', { bearer: support });
  assert.ok([401, 403].includes(r.status), `SUPPORT_AGENT must not read zones, got ${r.status}`);
});

// S6 (default): a path with no explicit branch must refuse FLEET_ADMIN. Before the fix the default
// included FLEET_ADMIN, so this path returned through the fallback.
test('S6: unlisted /api/admin/ path refuses FLEET_ADMIN', { skip }, async () => {
  const fleetAdmin = token({ id: 'fleet_s6default', role: 'FLEET_ADMIN' });
  const r = await call('GET', '/api/admin/s6-unlisted-probe', { bearer: fleetAdmin });
  assert.ok([401, 403].includes(r.status), `FLEET_ADMIN must not reach an unlisted admin path, got ${r.status}`);
});

// S5 (HTTP): a customer cannot move a trip to a driver-only state, even on a trip that does not exist.
test('S5: transition route refuses an unknown order for a customer without leaking state', { skip }, async () => {
  const customer = token({ id: 'usr_cust_s5http', role: 'CUSTOMER' });
  const r = await call('POST', '/api/orders/transition', { bearer: customer, body: { orderId: 'TRIP_s5_missing', nextState: 'DELIVERED' } });
  assert.ok(r.status === 403 || r.status === 404, `expected 403 or 404, got ${r.status}`);
});

// S7: the RazorpayX webhook must refuse unsigned or wrongly signed requests.
test('S7: webhook refuses an unsigned request', async () => {
  const r = await call('POST', '/api/webhooks/razorpayx', { body: { event: 'payout.processed', payload: { payout: { entity: { id: 'x' } } } } });
  assert.ok([401, 503].includes(r.status), `unsigned webhook must be refused, got ${r.status}`);
});

test('S7: webhook refuses a wrong signature', async () => {
  const r = await fetch(base + '/api/webhooks/razorpayx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef' },
    body: JSON.stringify({ event: 'payout.processed', payload: { payout: { entity: { id: 'x' } } } }),
    signal: AbortSignal.timeout(8000),
  });
  assert.ok([401, 503].includes(r.status), `wrong-signature webhook must be refused, got ${r.status}`);
});

// T14: the driver check runs before body field checks, so a refused caller is never told the body shape (400).
test('T14: anonymous emergency-reject with a bad body is refused as 401, not 400', { skip }, async () => {
  const r = await call('POST', '/api/trip/emergency-reject', { body: {} });
  assert.equal(r.status, 401, `anonymous caller must get 401, got ${r.status}`);
});

test('T14: anonymous telemetry ping with no coordinates is refused as 401, not 400', { skip }, async () => {
  const r = await call('POST', '/api/telemetry/ping', { body: {} });
  assert.equal(r.status, 401, `anonymous caller must get 401, got ${r.status}`);
});

test('T14: a customer with an invalid rejection body is refused as 403, not 400', { skip }, async () => {
  const customer = token({ id: 'usr_cust_t14', role: 'CUSTOMER' });
  const r = await call('POST', '/api/trip/emergency-reject', { bearer: customer, body: {} });
  assert.equal(r.status, 403, `a customer must be refused by the driver check, got ${r.status}`);
});

test('T14: a customer with no coordinates is refused as 403, not 400', { skip }, async () => {
  const customer = token({ id: 'usr_cust_t14b', role: 'CUSTOMER' });
  const r = await call('POST', '/api/telemetry/ping', { bearer: customer, body: {} });
  assert.equal(r.status, 403, `a customer must be refused by the driver check, got ${r.status}`);
});
