// Input handling tests (PRODUCT_ISSUES.md T3, T4). Run against a live server.
// Base http://127.0.0.1:4100 by default (VAAYU_TEST_BASE). Only refused or malformed requests are sent,
// so no state changes. Admin token minted from VAAYU_TEST_JWT_SECRET.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require(path.join(__dirname, '..', '..', 'node_modules', 'jsonwebtoken'));

const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4100';
const secret = process.env.VAAYU_TEST_JWT_SECRET || '';
const skip = secret.length < 32 ? 'VAAYU_TEST_JWT_SECRET not set' : false;

function token(user) {
  return jwt.sign({ id: user.id, name: 'test', phone: '', role: user.role, city: 'Hyderabad' }, secret, { algorithm: 'HS256', expiresIn: 300 });
}

async function raw(method, p, { bearer, bodyText, contentType = 'application/json', headers = {} } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': contentType, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers },
    body: bodyText,
    signal: AbortSignal.timeout(8000),
  });
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

// T3: malformed JSON must be a clear 400, not silently treated as an empty body.
test('T3: malformed JSON on a money route returns 400, not a silent success', { skip }, async () => {
  const admin = token({ id: 'adm_t3', role: 'ADMIN' });
  const r = await raw('POST', '/api/payouts/create', { bearer: admin, bodyText: '{not json' });
  assert.equal(r.status, 400, `malformed JSON must be refused, got ${r.status}`);
  assert.equal(r.data && r.data.success, false);
});

test('T3: malformed JSON on a trip route returns 400', { skip }, async () => {
  const cust = token({ id: 'usr_cust_t3', role: 'CUSTOMER' });
  const r = await raw('POST', '/api/trips/create', { bearer: cust, bodyText: '{"pickup":' });
  assert.equal(r.status, 400, `malformed JSON must be refused, got ${r.status}`);
});

// T3: a malformed body on a protected route is refused as unauthenticated first, not parsed.
test('T3: malformed JSON without a token is refused as 401, not 400', { skip }, async () => {
  const r = await raw('POST', '/api/trips/create', { bodyText: '{bad' });
  assert.equal(r.status, 401, `an anonymous caller must get 401 before body validation, got ${r.status}`);
});

// T4: a booking with no or invalid coordinates is refused, never placed at a default location.
test('T4: trip create refuses a missing pickup coordinate', { skip }, async () => {
  const cust = token({ id: 'usr_cust_t4coord', role: 'CUSTOMER' });
  const r = await raw('POST', '/api/trips/create', { bearer: cust, bodyText: JSON.stringify({ vehicleId: 'v_ace', pickupLng: 78.4, dropLat: 17.4, dropLng: 78.3 }) });
  assert.equal(r.status, 400, `missing pickupLat must be refused, got ${r.status}`);
  assert.equal(r.data && r.data.error && r.data.error.code, 'INVALID_FIELD');
});

test('T4: trip create refuses an out-of-range latitude', { skip }, async () => {
  const cust = token({ id: 'usr_cust_t4range', role: 'CUSTOMER' });
  const r = await raw('POST', '/api/trips/create', { bearer: cust, bodyText: JSON.stringify({ vehicleId: 'v_ace', pickupLat: 999, pickupLng: 78.4, dropLat: 17.4, dropLng: 78.3 }) });
  assert.equal(r.status, 400, `latitude 999 must be refused, got ${r.status}`);
});

// T4: money and fee fields are range-checked before any provider or persistence call.
test('T4: payment create-order refuses a negative amount', { skip }, async () => {
  const cust = token({ id: 'usr_cust_t4pay', role: 'CUSTOMER' });
  const r = await raw('POST', '/api/payment/create-order', { bearer: cust, bodyText: JSON.stringify({ amount: -100, purpose: 'TEST' }) });
  assert.equal(r.status, 400, `negative amount must be refused, got ${r.status}`);
  assert.equal(r.data && r.data.error && r.data.error.code, 'INVALID_FIELD');
});

test('T4: waiting-fee refuses minutes beyond a day', { skip }, async () => {
  const cust = token({ id: 'usr_cust_t4wait', role: 'CUSTOMER' });
  const r = await raw('POST', '/api/trip/calculate-waiting-fee', { bearer: cust, bodyText: JSON.stringify({ waiting_minutes: 999999, vehicle_category: 'v_ace' }) });
  assert.equal(r.status, 400, `out-of-range minutes must be refused, got ${r.status}`);
});

// T4: an OTP type outside PICKUP/DELIVERY is refused, never checked against the delivery code.
// Uses an ADMIN token: admins skip the trip-ownership check, so the request reaches field validation.
// A DRIVER on a trip they do not own is refused earlier (403), which is the intended order.
test('T4: order completion refuses a non-string delivery OTP', { skip }, async () => {
  const admin = token({ id: 'adm_t4otp', role: 'ADMIN' });
  const r = await raw('POST', '/api/orders/complete', { bearer: admin, bodyText: JSON.stringify({ orderId: 'TRIP_t4_missing', otp: { code: '1234' } }) });
  assert.notEqual(r.status, 200, `a malformed OTP must not complete an order, got ${r.status}`);
});

test('T4: order completion refuses an oversized proof of delivery', { skip }, async () => {
  const admin = token({ id: 'adm_t4proof', role: 'ADMIN' });
  const huge = 'a'.repeat(1_500_000);
  try {
    const r = await raw('POST', '/api/orders/complete', { bearer: admin, bodyText: JSON.stringify({ orderId: 'TRIP_t4_missing', otp: '1234', proof: { podPhotoUrl: huge } }), headers: { Connection: 'close' } });
    // The global 1 MB body cap refuses first, so an inline proof photo over 1 MB is never accepted as JSON.
    assert.equal(r.status, 413, `oversized proof must be refused, got ${r.status}`);
  } catch (err) {
    assert.ok(err.name === 'TypeError' || err.code === 'ECONNRESET', `oversized body must be rejected: ${err.message}`);
  }
});

test('T4: fleet assign refuses a missing vehicle_id', { skip }, async () => {
  const admin = token({ id: 'adm_t4fleet', role: 'ADMIN' });
  const r = await raw('POST', '/api/fleet/assign-driver', { bearer: admin, bodyText: JSON.stringify({ owner_id: 'own_x', driver_id: 'drv_x' }) });
  assert.equal(r.status, 400, `missing vehicle_id must be refused, got ${r.status}`);
});

// T4: merchant staff role is limited to known roles.
test('T4: merchant staff refuses an unknown role', { skip }, async () => {
  const merchant = token({ id: 'mer_t4staff', role: 'MERCHANT' });
  const r = await raw('POST', '/api/merchant/staff', { bearer: merchant, bodyText: JSON.stringify({ name: 'Test', phone: '9999999999', role: 'SUPERUSER' }) });
  assert.equal(r.status, 400, `unknown staff role must be refused, got ${r.status}`);
});

// T4: feedback rating must be a whole number from 1 to 5 (ratings feed driver scores).
test('T4: feedback refuses a rating outside 1 to 5', { skip }, async () => {
  const driver = token({ id: 'drv_t4fb', role: 'DRIVER' });
  const r = await raw('POST', '/api/feedback/submit', { bearer: driver, bodyText: JSON.stringify({ driver_id: 'drv_t4fb', trip_id: 'TRIP_t4_missing', rating: 1000 }) });
  assert.ok(r.status === 400 || r.status === 403, `out-of-range rating must be refused, got ${r.status}`);
  assert.notEqual(r.status, 200);
});

// T4: a support subject over 200 characters is refused.
test('T4: support ticket refuses an oversize subject', { skip }, async () => {
  const cust = token({ id: 'usr_cust_t4sup', role: 'CUSTOMER' });
  const r = await raw('POST', '/api/support/tickets/create', { bearer: cust, bodyText: JSON.stringify({ subject: 'x'.repeat(500), category: 'OTHER' }) });
  assert.equal(r.status, 400, `oversize subject must be refused, got ${r.status}`);
});

// T4: driver status must be a real boolean; the string "false" previously turned the driver online.
test('T4: driver status refuses a string isOnline', { skip }, async () => {
  const admin = token({ id: 'adm_t4status', role: 'ADMIN' });
  const r = await raw('POST', '/api/driver/status', { bearer: admin, bodyText: JSON.stringify({ driverId: 'drv_t4status', isOnline: 'false' }) });
  assert.equal(r.status, 400, `string isOnline must be refused, got ${r.status}`);
});

// T4: KYC step must be a whole number; a string "5" previously concatenated to "51".
test('T4: submit-step refuses a string step', { skip }, async () => {
  const admin = token({ id: 'adm_t4step', role: 'ADMIN' });
  const r = await raw('POST', '/api/documents/submit-step', { bearer: admin, bodyText: JSON.stringify({ driver_id: 'drv_t4step', step: '5', owner_name: 'Test' }) });
  assert.equal(r.status, 400, `string step must be refused, got ${r.status}`);
});

// T4: vehicle number is required.
test('T4: vehicle details refuses a missing vehicle_number', { skip }, async () => {
  const admin = token({ id: 'adm_t4veh', role: 'ADMIN' });
  const r = await raw('POST', '/api/documents/vehicle-details', { bearer: admin, bodyText: JSON.stringify({ driver_id: 'drv_t4veh', city: 'Hyderabad' }) });
  assert.equal(r.status, 400, `missing vehicle_number must be refused, got ${r.status}`);
});

// T4: breakdown signal coordinates must be valid.
test('T4: breakdown signal refuses an out-of-range latitude', { skip }, async () => {
  const admin = token({ id: 'adm_t4brk', role: 'ADMIN' });
  const r = await raw('POST', '/api/trip/breakdown-signal', { bearer: admin, bodyText: JSON.stringify({ tripId: 'TRIP_t4_missing', driverId: 'drv_t4brk', lat: 999, lng: 78.4 }) });
  assert.equal(r.status, 400, `out-of-range lat must be refused, got ${r.status}`);
});

// WebSocket subscribe was unauthenticated and trusted userId/role from the body. It must now require a token.
test('T4: ws subscribe refuses an anonymous caller', { skip }, async () => {
  const r = await raw('POST', '/api/ws/subscribe', { bodyText: JSON.stringify({ roomName: 'fleet:hyderabad', userId: 'adm_x', role: 'ADMIN' }) });
  assert.equal(r.status, 401, `anonymous ws subscribe must be refused, got ${r.status}`);
});

test('T4: ws subscribe refuses a missing roomName', { skip }, async () => {
  const cust = token({ id: 'usr_t4ws', role: 'CUSTOMER' });
  const r = await raw('POST', '/api/ws/subscribe', { bearer: cust, bodyText: JSON.stringify({ userId: 'adm_x', role: 'ADMIN' }) });
  assert.equal(r.status, 400, `missing roomName must be refused, got ${r.status}`);
});

test('T4: cancel schedule refuses a missing schedule_id', { skip }, async () => {
  const merchant = token({ id: 'mer_t4cancel', role: 'MERCHANT' });
  const r = await raw('POST', '/api/merchant/schedules/cancel', { bearer: merchant, bodyText: JSON.stringify({}) });
  assert.equal(r.status, 400, `missing schedule_id must be refused, got ${r.status}`);
});

test('T4: parse-csv refuses content over 200 KB', { skip }, async () => {
  const merchant = token({ id: 'mer_t4csv', role: 'MERCHANT' });
  const r = await raw('POST', '/api/merchant/parse-csv', { bearer: merchant, bodyText: JSON.stringify({ csvContent: 'a'.repeat(210000) }) });
  assert.equal(r.status, 400, `csv over 200 KB must be refused by the field rule, got ${r.status}`);
});

// T4: support chat query is required and bounded.
test('T4: support ai-chat refuses an empty query', { skip }, async () => {
  const cust = token({ id: 'usr_t4chat', role: 'CUSTOMER' });
  const r = await raw('POST', '/api/support/ai-chat', { bearer: cust, bodyText: JSON.stringify({ query: '   ' }) });
  assert.equal(r.status, 400, `empty query must be refused, got ${r.status}`);
});

// T4: AI document verify with no verifier must not report success.
test('T4: ai-auto-verify does not report success when the verifier is unavailable', { skip }, async () => {
  const driver = token({ id: 'drv_t4ai', role: 'DRIVER' });
  const r = await raw('POST', '/api/documents/ai-auto-verify', { bearer: driver, bodyText: JSON.stringify({ driver_id: 'drv_t4ai', category: 'RC' }) });
  assert.ok([200, 400, 403, 404].includes(r.status), `unexpected status ${r.status}`);
  assert.notEqual(r.data && r.data.success, true, `success must never be true without a verifier (status ${r.status})`);
});

// T4: a required field of the wrong type must be refused before reaching business logic.
test('T4: wrong-type amount on a wallet credit is refused', { skip }, async () => {
  const admin = token({ id: 'adm_t4', role: 'ADMIN' });
  const r = await raw('POST', '/api/admin/customers/wallet-credit', { bearer: admin, bodyText: JSON.stringify({ customerId: 'usr_cust_none', amount: 'abc' }) });
  assert.ok(r.status === 400 || r.status === 404, `non-numeric amount must be refused, got ${r.status}`);
  assert.notEqual(r.status, 200, 'a non-numeric amount must never succeed');
});

test('T4: negative payout amount is refused', { skip }, async () => {
  const admin = token({ id: 'adm_t4b', role: 'ADMIN' });
  const r = await raw('POST', '/api/payouts/create', { bearer: admin, bodyText: JSON.stringify({ amount: -500, driverId: 'drv_none' }) });
  assert.notEqual(r.status, 200, 'a negative payout must never succeed');
});
