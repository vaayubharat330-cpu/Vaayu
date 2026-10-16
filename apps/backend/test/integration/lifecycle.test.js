// Automated End-to-End Enterprise Delivery Lifecycle Integration Test
// This test intentionally uses the public HTTP surface. OTPs are read only from the
// test PostgreSQL store after booking; the booking response must never expose deliveryOtp.
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

function makeToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, phone: user.phone, role: user.role, city: 'Hyderabad' },
    secret,
    { algorithm: 'HS256', expiresIn: 300 }
  );
}

async function loadAuthoritativeOtpAndTracking(tripId) {
  assert.ok(databaseUrl, 'DATABASE_URL is required for the E2E test');
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const { rows } = await pool.query(
      "SELECT data FROM vaayu_records WHERE collection = 'trips' AND record_key = $1",
      [`id:${tripId}`]
    );
    assert.equal(rows.length, 1, 'Trip must exist in authoritative PostgreSQL storage');
    const stored = rows[0].data;
    assert.ok(stored.pickupOtp, 'Authoritative trip must contain pickup OTP');
    assert.ok(stored.deliveryOtp, 'Authoritative trip must contain delivery OTP');
    assert.ok(stored.trackingToken, 'Authoritative trip must contain tracking token');
    return {
      pickupOtp: stored.pickupOtp,
      deliveryOtp: stored.deliveryOtp,
      trackingToken: stored.trackingToken
    };
  } finally {
    await pool.end();
  }
}

test('E2E: Full delivery lifecycle with dispatch, geofenced telemetry, public tracking and OTP privacy', async () => {
  assert.ok(secret.length >= 32, 'JWT secret must be at least 32 chars');

  const adminToken = makeToken({ id: 'adm_e2e_super', name: 'Ops Admin', phone: '9999999999', role: 'ADMIN' });

  // 1. Create Driver via Admin HTTP API
  const driverPhone = '90000' + Math.floor(10000 + Math.random() * 90000);
  const createDrvRes = await fetch(base + '/api/admin/drivers/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({
      name: 'Ramesh Captain',
      phone: driverPhone,
      vehicleId: 'v_2w',
      vehicleNumber: 'TS09UB8899',
      city: 'Hyderabad'
    })
  });
  const drvData = await createDrvRes.json();
  assert.equal(createDrvRes.status, 201, 'Driver creation must succeed');
  assert.ok(drvData.success, 'Driver create success flag');
  const driver = drvData.driver;

  // 2. Approve KYC via Admin HTTP API
  const kycRes = await fetch(base + '/api/admin/drivers/update-kyc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({ driverId: driver.id, kycStatus: 'APPROVED' })
  });
  const kycData = await kycRes.json();
  assert.equal(kycRes.status, 200, 'KYC approval must succeed');
  assert.ok(kycData.success, 'KYC approved flag');

  // 3. Driver goes ONLINE with pickup coordinates
  const driverToken = makeToken({ id: driver.userId, name: driver.name, phone: driver.phone, role: 'DRIVER' });
  const onlineRes = await fetch(base + '/api/driver/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ driver_id: driver.id, status: 'ONLINE', lat: 17.3850, lng: 78.4867 })
  });
  const onlineData = await onlineRes.json();
  assert.equal(onlineRes.status, 200, 'Driver online must succeed');
  assert.ok(onlineData.success, 'Driver online flag');

  // 4. Create customer booking with an idempotency key.
  const customerToken = makeToken({ id: 'cust_auto_1', name: 'Ananya Sharma', phone: '9876543211', role: 'CUSTOMER' });
  const bookingIdempotencyKey = `e2e-booking-${Date.now()}`;
  const bookingPayload = {
    pickupLat: 17.3850,
    pickupLng: 78.4867,
    dropLat: 17.4400,
    dropLng: 78.3489,
    pickupAddress: 'Abids, Hyderabad',
    dropAddress: 'Hitec City, Hyderabad',
    vehicleId: 'v_2w',
    paymentMethod: 'CASH_ON_DELIVERY',
    idempotencyKey: bookingIdempotencyKey
  };
  const bookRes = await fetch(base + '/api/trips/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + customerToken,
      'X-Idempotency-Key': bookingIdempotencyKey
    },
    body: JSON.stringify(bookingPayload)
  });
  const bookData = await bookRes.json();
  assert.equal(bookRes.status, 200, 'Trip booking must succeed');
  assert.ok(bookData.success, 'Booking success flag');
  const trip = bookData.trip;
  assert.ok(trip.pickupOtp, 'Pickup OTP may be returned for the authenticated booking flow');
  assert.equal(Object.prototype.hasOwnProperty.call(trip, 'deliveryOtp'), false, 'Delivery OTP must not be returned in booking response');
  assert.ok(trip.trackingToken, 'Tracking token must be returned');

  // 5. Replay the exact command: idempotency must return the same trip rather than create another one.
  const replayRes = await fetch(base + '/api/trips/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + customerToken,
      'X-Idempotency-Key': bookingIdempotencyKey
    },
    body: JSON.stringify(bookingPayload)
  });
  const replayData = await replayRes.json();
  assert.equal(replayRes.status, 200, 'Idempotent replay must succeed');
  assert.equal(replayData.trip.id, trip.id, 'Idempotent replay must return the original trip');

  // 6. Read authoritative OTPs and tracking token from PostgreSQL, never from the HTTP response.
  const secrets = await loadAuthoritativeOtpAndTracking(trip.id);
  assert.equal(secrets.trackingToken, trip.trackingToken, 'Public tracking token must match durable trip state');
  const pickupOtp = secrets.pickupOtp;
  const deliveryOtp = secrets.deliveryOtp;

  // 7. Public recipient tracking is token-gated and must expose delivery state without OTPs.
  const trackingRes = await fetch(base + '/api/public/tracking/' + encodeURIComponent(secrets.trackingToken));
  const trackingData = await trackingRes.json();
  assert.equal(trackingRes.status, 200, 'Public tracking endpoint must succeed with valid token');
  assert.equal(trackingData.trip.id, trip.id, 'Tracking endpoint must resolve the correct trip');
  assert.equal(Object.prototype.hasOwnProperty.call(trackingData.trip, 'deliveryOtp'), false, 'Tracking endpoint must never expose delivery OTP');

  // 8. Admin assigns the reserved driver to the order.
  const assignRes = await fetch(base + '/api/admin/dispatch/assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({ orderId: trip.id, driverId: driver.id })
  });
  const assignData = await assignRes.json();
  assert.equal(assignRes.status, 200, 'Admin assignment must succeed');
  assert.ok(assignData.success, 'Driver assignment flag');

  // 9. Driver accepts the offer.
  const acceptRes = await fetch(base + '/api/orders/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id, idempotencyKey: `e2e-accept-${trip.id}` })
  });
  const acceptData = await acceptRes.json();
  assert.equal(acceptRes.status, 200, 'Driver accept must succeed');
  assert.ok(acceptData.success, 'Accept success flag');

  // 10. Driver starts arriving to pickup.
  const startArriveRes = await fetch(base + '/api/orders/start-arriving', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id, idempotencyKey: `e2e-arriving-${trip.id}` })
  });
  const startArriveData = await startArriveRes.json();
  assert.equal(startArriveRes.status, 200, 'Start arriving must succeed');
  assert.ok(startArriveData.success, 'Start arriving flag');

  // 11. Telemetry at pickup, then geofenced pickup confirmation.
  const pickupTelemetryRes = await fetch(base + '/api/driver/location/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ driverId: driver.id, lat: 17.38505, lng: 78.48672, speed: 0, bearing: 0 })
  });
  assert.equal(pickupTelemetryRes.status, 200, 'Pickup telemetry must be accepted');

  const arriveRes = await fetch(base + '/api/orders/arrived-pickup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id, idempotencyKey: `e2e-arrive-pickup-${trip.id}` })
  });
  const arriveData = await arriveRes.json();
  assert.equal(arriveRes.status, 200, 'Arrived at pickup must succeed');
  assert.ok(arriveData.success, 'Arrived pickup flag');

  // 12. Confirm pickup with the authoritative pickup OTP.
  const pickupRes = await fetch(base + '/api/orders/confirm-pickup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id, otp: pickupOtp, idempotencyKey: `e2e-pickup-${trip.id}` })
  });
  const pickupData = await pickupRes.json();
  assert.equal(pickupRes.status, 200, 'Pickup confirmation must succeed');
  assert.ok(pickupData.success, 'Pickup confirmation flag');

  // 13. Start transit.
  const transitRes = await fetch(base + '/api/orders/start-transit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id, idempotencyKey: `e2e-transit-${trip.id}` })
  });
  const transitData = await transitRes.json();
  assert.equal(transitRes.status, 200, 'Start transit must succeed');
  assert.ok(transitData.success, 'Start transit flag');

  // 14. Telemetry at destination and geofenced dropoff.
  const dropTelemetryRes = await fetch(base + '/api/driver/location/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ driverId: driver.id, lat: 17.44002, lng: 78.34891, speed: 0, bearing: 270, bypassSpeedFilter: true })
  });
  assert.equal(dropTelemetryRes.status, 200, 'Destination telemetry must be accepted');

  const dropRes = await fetch(base + '/api/orders/arrived-dropoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id, idempotencyKey: `e2e-arrive-dropoff-${trip.id}` })
  });
  const dropData = await dropRes.json();
  assert.equal(dropRes.status, 200, 'Arrived at dropoff must succeed');
  assert.ok(dropData.success, 'Arrived dropoff flag');

  // 15. Complete delivery with authoritative Delivery OTP + receiver name.
  const completeRes = await fetch(base + '/api/orders/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({
      orderId: trip.id,
      otp: deliveryOtp,
      idempotencyKey: `e2e-complete-${trip.id}`,
      proof: { receiverName: 'Ananya Sharma' }
    })
  });
  const completeData = await completeRes.json();
  assert.equal(completeRes.status, 200, 'Complete delivery must succeed');
  assert.ok(completeData.success, 'Complete delivery flag');
  assert.equal(completeData.status || completeData.trip?.status, 'DELIVERED', 'Terminal state must be DELIVERED');
  assert.equal(Object.prototype.hasOwnProperty.call(completeData.trip || {}, 'deliveryOtp'), false, 'Completion response must not expose delivery OTP');
});
