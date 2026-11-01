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

async function post(url, auth, body) {
  const res = await fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

async function readTrip(tripId) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { rows } = await pool.query("SELECT data FROM vaayu_records WHERE collection='trips' AND record_key=$1", [`id:${tripId}`]);
    assert.equal(rows.length, 1, 'Authoritative PostgreSQL trip must exist');
    return rows[0].data;
  } finally { await pool.end(); }
}

test('Cross-role shared state: customer booking, dispatch, driver acceptance and public tracking converge', async () => {
  assert.ok(secret.length >= 32, 'JWT secret must be at least 32 chars');
  assert.ok(databaseUrl, 'DATABASE_URL is required');

  const admin = token({ id: 'adm_shared_cert', name: 'Shared State Admin', phone: '9999988888', role: 'ADMIN' });
  const phone = '90000' + Math.floor(10000 + Math.random() * 90000);
  const created = await post('/api/admin/drivers/create', admin, {
    name: 'Shared State Driver', phone, vehicleId: 'v_2w', vehicleNumber: 'TS09SS1234', city: 'Hyderabad'
  });
  assert.equal(created.status, 201, 'Admin driver creation must succeed');
  const driver = created.data.driver;
  const kyc = await post('/api/admin/drivers/update-kyc', admin, { driverId: driver.id, kycStatus: 'APPROVED' });
  assert.equal(kyc.status, 200, 'Driver KYC approval must succeed');

  const driverToken = token({ id: driver.userId, name: driver.name, phone: driver.phone, role: 'DRIVER' });
  const online = await post('/api/driver/update', driverToken, { driver_id: driver.id, status: 'ONLINE', lat: 17.3850, lng: 78.4867 });
  assert.equal(online.status, 200, 'Driver must become ONLINE');
  const ping = await post('/api/driver/location/update', driverToken, { driverId: driver.id, lat: 17.3850, lng: 78.4867, speed: 0, bearing: 0 });
  assert.equal(ping.status, 200, 'Fresh driver telemetry must be accepted');

  const customerId = `cust_shared_${Date.now()}`;
  const customer = token({ id: customerId, name: 'Shared State Customer', phone: '9876501234', role: 'CUSTOMER' });
  const key = `shared-state-${Date.now()}`;
  const booking = await post('/api/trips/create', customer, {
    pickupLat: 17.3850, pickupLng: 78.4867, dropLat: 17.4400, dropLng: 78.3489,
    pickupAddress: 'Abids, Hyderabad', dropAddress: 'Hitec City, Hyderabad', vehicleId: 'v_2w',
    paymentMethod: 'CASH_ON_DELIVERY', idempotencyKey: key
  });
  assert.equal(booking.status, 200, 'Customer booking must succeed');
  assert.ok(booking.data.dispatch?.success, 'Automatic dispatch must succeed');
  const tripId = booking.data.trip.id;
  assert.equal(booking.data.dispatch.assignedDriver.driverId, driver.id, 'Dispatch and admin-created driver must agree');
  assert.equal(Object.hasOwn(booking.data.trip, 'deliveryOtp'), false, 'Booking response must not expose delivery OTP');

  let trip = await readTrip(tripId);
  assert.equal(trip.id, tripId, 'PostgreSQL id must match booking');
  assert.equal(trip.customerId, customerId, 'PostgreSQL customer must match booking actor');
  assert.equal(trip.driverId, driver.id, 'PostgreSQL driver must match dispatch');
  assert.ok(trip.trackingToken, 'Authoritative trip must contain tracking token');
  assert.ok(trip.pickupOtp && trip.deliveryOtp, 'Authoritative trip must contain protected OTPs');

  const tracking = await fetch(base + '/api/public/tracking/' + encodeURIComponent(trip.trackingToken));
  const trackingData = await tracking.json();
  assert.equal(tracking.status, 200, 'Customer tracking must resolve');
  assert.equal(trackingData.trip.id, tripId, 'Tracking must resolve the same trip');
  assert.equal(trackingData.trip.driverId, trip.driverId, 'Tracking driver must equal PostgreSQL driver');
  assert.equal(Object.hasOwn(trackingData.trip, 'deliveryOtp'), false, 'Tracking must not expose delivery OTP');

  const accept = await post('/api/orders/accept', driverToken, { orderId: tripId, idempotencyKey: `shared-accept-${tripId}` });
  assert.equal(accept.status, 200, 'Driver acceptance must succeed');
  trip = await readTrip(tripId);
  assert.equal(trip.driverId, driver.id, 'Accepted trip must retain the dispatched driver');
  assert.equal(trip.status, 'ACCEPTED', 'PostgreSQL state must become ACCEPTED after driver action');

  const replay = await post('/api/orders/accept', driverToken, { orderId: tripId, idempotencyKey: `shared-accept-${tripId}` });
  assert.equal(replay.status, 200, 'Acceptance replay must remain successful/idempotent');
  const afterReplay = await readTrip(tripId);
  assert.equal(afterReplay.id, tripId, 'Acceptance replay must not create a second trip');
  assert.equal(afterReplay.status, 'ACCEPTED', 'Acceptance replay must not corrupt terminal transition state');
});
