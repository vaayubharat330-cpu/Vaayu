'use strict';

// Negative-path certification: rejected commands must not mutate authoritative state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require(path.join(__dirname, '..', '..', 'node_modules', 'dotenv'));
const jwt = require(path.join(__dirname, '..', '..', 'node_modules', 'jsonwebtoken'));
const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));

const envFile = path.resolve(__dirname, '..', '..', '.env');
const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const secret = process.env.VAAYU_TEST_JWT_SECRET || parsed.JWT_SECRET || '';
const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000';
const databaseUrl = process.env.DATABASE_URL || parsed.DATABASE_URL || '';

function token(user) {
  return jwt.sign({ ...user, city: 'Hyderabad' }, secret, { algorithm: 'HS256', expiresIn: 300 });
}

async function request(pathname, auth, body) {
  const response = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function readTrip(tripId) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query("SELECT data FROM vaayu_records WHERE collection='trips' AND record_key=$1", [`id:${tripId}`]);
    assert.equal(result.rows.length, 1);
    return result.rows[0].data;
  } finally {
    await pool.end();
  }
}

test('Negative-path certification: authorization, idempotency conflict and token rejection preserve state', async () => {
  assert.ok(secret.length >= 32, 'JWT secret must be at least 32 chars');
  assert.ok(databaseUrl, 'DATABASE_URL is required');

  const admin = token({ id: `adm_fail_${Date.now()}`, name: 'Failure Test Admin', phone: '9999911111', role: 'ADMIN' });
  const phone = '90400' + Math.floor(10000 + Math.random() * 90000);
  const created = await request('/api/admin/drivers/create', admin, {
    name: 'Failure Test Driver', phone, vehicleId: 'v_2w', vehicleNumber: 'TS09F' + Math.floor(10000 + Math.random() * 90000), city: 'Hyderabad'
  });
  assert.equal(created.status, 201);
  const driver = created.body.driver;

  const kyc = await request('/api/admin/drivers/update-kyc', admin, { driverId: driver.id, kycStatus: 'APPROVED' });
  assert.equal(kyc.status, 200);
  const driverToken = token({ id: driver.userId, name: driver.name, phone: driver.phone, role: 'DRIVER' });
  assert.equal((await request('/api/driver/update', driverToken, { driver_id: driver.id, status: 'ONLINE', lat: 17.3850, lng: 78.4867 })).status, 200);
  assert.equal((await request('/api/driver/location/update', driverToken, { driverId: driver.id, lat: 17.3850, lng: 78.4867, speed: 0, bearing: 0 })).status, 200);

  const customer = token({ id: `cust_fail_${Date.now()}`, name: 'Failure Test Customer', phone: '9888811111', role: 'CUSTOMER' });
  const key = `failure-booking-${Date.now()}`;
  const payload = {
    pickupLat: 17.3850, pickupLng: 78.4867, dropLat: 17.4400, dropLng: 78.3489,
    pickupAddress: 'Abids, Hyderabad', dropAddress: 'Hitec City, Hyderabad', vehicleId: 'v_2w',
    paymentMethod: 'CASH_ON_DELIVERY', idempotencyKey: key
  };
  const booking = await request('/api/trips/create', customer, payload);
  assert.equal(booking.status, 200);
  const tripId = booking.body.trip.id;
  assert.equal(booking.body.dispatch.assignedDriver.driverId, driver.id);

  const before = await readTrip(tripId);
  assert.equal(before.status, 'DRIVER_ASSIGNED');

  // BOLA: a different driver may not accept another driver's assigned trip.
  const stranger = token({ id: `drv_stranger_${Date.now()}`, name: 'Stranger Driver', phone: '9777711111', role: 'DRIVER' });
  const unauthorized = await request('/api/orders/accept', stranger, { orderId: tripId, idempotencyKey: `unauth-${tripId}` });
  assert.notEqual(unauthorized.status, 200, 'Unauthorized driver acceptance must be rejected');
  const afterUnauthorized = await readTrip(tripId);
  assert.equal(afterUnauthorized.status, before.status, 'Rejected authorization must not mutate trip state');
  assert.equal(afterUnauthorized.driverId, before.driverId, 'Rejected authorization must preserve assigned driver');

  // Idempotency payload mismatch: reusing a booking key for a different payload must be rejected.
  const altered = { ...payload, dropLat: 17.5000, dropLng: 78.5000 };
  const mismatch = await request('/api/trips/create', customer, altered);
  assert.notEqual(mismatch.status, 200, 'Idempotency key reuse with altered payload must be rejected');
  const afterMismatch = await readTrip(tripId);
  assert.equal(afterMismatch.id, tripId, 'Idempotency conflict must preserve original trip');
  assert.equal(afterMismatch.dropLat, before.dropLat, 'Idempotency conflict must not replace destination');

  // Public tracking must reject an invalid capability token.
  const tracking = await fetch(base + '/api/public/tracking/invalid-token-for-certification');
  assert.notEqual(tracking.status, 200, 'Invalid tracking capability must be rejected');
});
