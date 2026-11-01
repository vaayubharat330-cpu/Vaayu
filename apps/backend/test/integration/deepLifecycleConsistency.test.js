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
  return jwt.sign({ ...user, city: 'Hyderabad' }, secret, { algorithm: 'HS256', expiresIn: 600 });
}

async function request(method, url, auth, body) {
  const options = { method, headers: { Authorization: `Bearer ${auth}` } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, options);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  return { status: res.status, data };
}

async function readTrip(tripId) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { rows } = await pool.query("SELECT data FROM vaayu_records WHERE collection='trips' AND record_key=$1", [`id:${tripId}`]);
    assert.equal(rows.length, 1, `Authoritative PostgreSQL trip ${tripId} must exist`);
    return rows[0].data;
  } finally { await pool.end(); }
}

async function transition(driverToken, tripId, action, extra = {}) {
  return request('POST', `/api/orders/${action}`, driverToken, { orderId: tripId, idempotencyKey: `deep-${action}-${tripId}`, ...extra });
}

function assertState(trip, expected, label) {
  assert.equal(trip.status, expected, `${label}: PostgreSQL state must be ${expected}`);
  assert.ok(Number.isInteger(Number(trip.version)) && Number(trip.version) > 0, `${label}: version must remain valid`);
}

test('Deep lifecycle: dispatch -> acceptance -> pickup OTP -> transit -> dropoff OTP -> delivery', async () => {
  assert.ok(secret.length >= 32, 'JWT secret must be at least 32 chars');
  assert.ok(databaseUrl, 'DATABASE_URL is required');

  const admin = token({ id: 'adm_deep_cert', name: 'Deep Lifecycle Admin', phone: '9999977777', role: 'ADMIN' });
  const phone = '91111' + Math.floor(10000 + Math.random() * 90000);
  const created = await request('POST', '/api/admin/drivers/create', admin, {
    name: 'Deep Lifecycle Driver', phone, vehicleId: 'v_2w', vehicleNumber: 'TS09DL4321', city: 'Hyderabad'
  });
  assert.equal(created.status, 201, 'Admin driver creation must succeed');
  const driver = created.data.driver;
  assert.ok(driver?.id && driver?.userId, 'Driver identity must be complete');

  const kyc = await request('POST', '/api/admin/drivers/update-kyc', admin, { driverId: driver.id, kycStatus: 'APPROVED' });
  assert.equal(kyc.status, 200, 'Driver KYC approval must succeed');

  const driverToken = token({ id: driver.userId, name: driver.name, phone: driver.phone, role: 'DRIVER' });
  const pickup = { lat: 17.3850, lng: 78.4867 };
  const drop = { lat: 17.4400, lng: 78.3489 };
  assert.equal((await request('POST', '/api/driver/update', driverToken, { driver_id: driver.id, status: 'ONLINE', ...pickup })).status, 200, 'Driver must become ONLINE');
  assert.equal((await request('POST', '/api/driver/location/update', driverToken, { driverId: driver.id, ...pickup, speed: 0, bearing: 0 })).status, 200, 'Initial telemetry must be accepted');

  const customerId = `cust_deep_${Date.now()}`;
  const customerToken = token({ id: customerId, name: 'Deep Lifecycle Customer', phone: '9876512345', role: 'CUSTOMER' });
  const booking = await request('POST', '/api/trips/create', customerToken, {
    pickupLat: pickup.lat, pickupLng: pickup.lng, dropLat: drop.lat, dropLng: drop.lng,
    pickupAddress: 'Abids, Hyderabad', dropAddress: 'Hitec City, Hyderabad', vehicleId: 'v_2w',
    paymentMethod: 'CASH_ON_DELIVERY', idempotencyKey: `deep-book-${Date.now()}`
  });
  assert.equal(booking.status, 200, 'Customer booking must succeed');
  assert.ok(booking.data.dispatch?.success, 'Dispatch must produce an active offer');
  assert.equal(booking.data.dispatch.assignedDriver.driverId, driver.id, 'Dispatch must select the prepared driver');
  const tripId = booking.data.trip.id;

  let trip = await readTrip(tripId);
  assertState(trip, 'DRIVER_ASSIGNED', 'dispatch');
  assert.equal(trip.driver?.id, driver.id, 'Persisted driver identity must match dispatch');
  const initialVersion = trip.version;
  const pickupOtp = String(trip.pickupOtp);
  const deliveryOtp = String(trip.deliveryOtp);
  assert.ok(pickupOtp && deliveryOtp, 'Protected lifecycle OTPs must exist in authoritative state');
  assert.equal(Object.hasOwn(booking.data.trip, 'pickupOtp'), false, 'Booking response must not expose pickup OTP');
  assert.equal(Object.hasOwn(booking.data.trip, 'deliveryOtp'), false, 'Booking response must not expose delivery OTP');

  let tracking = await request('GET', `/api/public/tracking/${encodeURIComponent(trip.trackingToken)}`);
  assert.equal(tracking.status, 200, 'Public tracking must resolve after dispatch');
  assert.equal(tracking.data.trip.status, trip.status, 'Tracking state must equal PostgreSQL state');

  let result = await transition(driverToken, tripId, 'accept');
  assert.equal(result.status, 200, 'Driver acceptance must succeed');
  trip = await readTrip(tripId);
  assertState(trip, 'DRIVER_ACCEPTED', 'acceptance');
  assert.equal(trip.version, initialVersion + 1, 'Acceptance must advance version exactly once');

  result = await transition(driverToken, tripId, 'start-arriving');
  assert.equal(result.status, 200, 'Driver start-arriving must succeed');
  trip = await readTrip(tripId);
  assertState(trip, 'DRIVER_ARRIVING', 'arriving');

  // Wrong location must be rejected by the pickup geofence without mutating lifecycle state.
  const farAway = await request('POST', '/api/driver/location/update', driverToken, { driverId: driver.id, lat: 17.5000, lng: 78.6000, speed: 0, bearing: 0 });
  assert.equal(farAway.status, 200, 'Telemetry update itself should remain valid');
  result = await transition(driverToken, tripId, 'arrived-pickup');
  assert.equal(result.status, 400, 'Pickup arrival outside geofence must be rejected');
  assert.equal(result.data.error?.code, 'GEOFENCE_VALIDATION_FAILED', 'Pickup rejection must identify geofence validation');
  trip = await readTrip(tripId);
  assertState(trip, 'DRIVER_ARRIVING', 'failed pickup geofence');

  // Return to pickup and continue.
  assert.equal((await request('POST', '/api/driver/location/update', driverToken, { driverId: driver.id, ...pickup, speed: 0, bearing: 0 })).status, 200, 'Pickup telemetry must be accepted');
  result = await transition(driverToken, tripId, 'arrived-pickup');
  assert.equal(result.status, 200, 'Driver arrival at pickup must succeed');
  trip = await readTrip(tripId);
  assertState(trip, 'DRIVER_AT_PICKUP', 'pickup arrival');

  result = await transition(driverToken, tripId, 'confirm-pickup', { otp: '0000' });
  assert.equal(result.status, 400, 'Incorrect pickup OTP must be rejected');
  assert.equal(result.data.error?.code, 'OTP_VERIFICATION_FAILED', 'Pickup OTP rejection must be explicit');
  trip = await readTrip(tripId);
  assertState(trip, 'DRIVER_AT_PICKUP', 'failed pickup OTP');

  result = await transition(driverToken, tripId, 'confirm-pickup', { otp: pickupOtp });
  assert.equal(result.status, 200, 'Correct pickup OTP must succeed');
  trip = await readTrip(tripId);
  assertState(trip, 'PICKUP_CONFIRMED', 'pickup confirmation');

  result = await transition(driverToken, tripId, 'start-transit');
  assert.equal(result.status, 200, 'Transit start must succeed');
  trip = await readTrip(tripId);
  assertState(trip, 'IN_TRANSIT', 'transit');

  assert.equal((await request('POST', '/api/driver/location/update', driverToken, { driverId: driver.id, ...drop, speed: 0, bearing: 0 })).status, 200, 'Dropoff telemetry must be accepted');
  result = await transition(driverToken, tripId, 'arrived-dropoff');
  assert.equal(result.status, 200, 'Driver arrival at dropoff must succeed');
  trip = await readTrip(tripId);
  assertState(trip, 'DRIVER_AT_DROPOFF', 'dropoff arrival');

  result = await transition(driverToken, tripId, 'complete', { otp: '0000' });
  assert.equal(result.status, 400, 'Incorrect delivery OTP must be rejected');
  assert.equal(result.data.error?.code, 'OTP_VERIFICATION_FAILED', 'Delivery OTP rejection must be explicit');
  trip = await readTrip(tripId);
  assertState(trip, 'DRIVER_AT_DROPOFF', 'failed delivery OTP');

  result = await transition(driverToken, tripId, 'complete', {
    otp: deliveryOtp,
    proof: { receiverName: 'Deep Lifecycle Receiver' }
  });
  assert.equal(result.status, 200, 'Correct delivery OTP must complete the trip');
  trip = await readTrip(tripId);
  assertState(trip, 'DELIVERED', 'delivery');
  assert.ok(trip.completedAt, 'Delivered trip must have completedAt');
  assert.equal(trip.proofOfDelivery?.receiverName, 'Deep Lifecycle Receiver', 'Proof-of-delivery receiver must persist');

  tracking = await request('GET', `/api/public/tracking/${encodeURIComponent(trip.trackingToken)}`);
  assert.equal(tracking.status, 200, 'Public tracking must remain resolvable after completion');
  assert.equal(tracking.data.trip.status, 'DELIVERED', 'Tracking must expose final lifecycle state');
  assert.equal(Object.hasOwn(tracking.data.trip, 'deliveryOtp'), false, 'Tracking must never expose delivery OTP');

  const audit = await request('GET', `/api/orders/audit?orderId=${encodeURIComponent(tripId)}`, driverToken);
  assert.equal(audit.status, 200, 'Authorized driver must be able to retrieve lifecycle audit');
  assert.ok(audit.data.count >= 8, 'Lifecycle audit must contain the complete transition history');
  assert.equal(audit.data.auditLogs.at(-1).toState, 'DELIVERED', 'Final audit entry must be DELIVERED');
  assert.equal(audit.data.auditLogs.at(-1).version, trip.version, 'Final audit version must equal persisted trip version');
});
