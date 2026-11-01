'use strict';

// Deep real-time certification:
// PostgreSQL authoritative state -> lifecycle command -> WebSocket event -> tracking/API state.
// This intentionally exercises independent customer and driver WebSocket sessions against the
// same disposable backend instance and verifies that realtime notifications never become a
// second source of truth.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require(path.join(__dirname, '..', '..', 'node_modules', 'dotenv'));
const jwt = require(path.join(__dirname, '..', '..', 'node_modules', 'jsonwebtoken'));
const WebSocket = require(path.join(__dirname, '..', '..', 'node_modules', 'ws'));
const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));

const envFile = path.resolve(__dirname, '..', '..', '.env');
const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const secret = process.env.VAAYU_TEST_JWT_SECRET || parsed.JWT_SECRET || '';
const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000';
const databaseUrl = process.env.DATABASE_URL || parsed.DATABASE_URL || '';
const wsBase = base.replace(/^http/, 'ws');

function token(user) {
  return jwt.sign({ ...user, city: 'Hyderabad' }, secret, { algorithm: 'HS256', expiresIn: 300 });
}

async function post(url, auth, body) {
  const response = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  return { status: response.status, data };
}

async function readTrip(tripId) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query("SELECT data FROM vaayu_records WHERE collection='trips' AND record_key=$1", [`id:${tripId}`]);
    assert.equal(result.rows.length, 1, 'Authoritative PostgreSQL trip must exist');
    return result.rows[0].data;
  } finally {
    await pool.end();
  }
}

function connectWs(auth) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(auth)}`);
    const onError = error => { ws.removeListener('open', onOpen); reject(error); };
    const onOpen = () => { ws.removeListener('error', onError); resolve(ws); };
    ws.once('error', onError);
    ws.once('open', onOpen);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!predicate || predicate(message)) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(message);
        }
      } catch (_) {}
    };
    ws.on('message', onMessage);
  });
}

async function join(ws, room) {
  ws.send(JSON.stringify({ action: 'join', room }));
  const result = await waitForMessage(ws, message => message.event === 'room_joined' && message.room === room);
  assert.equal(result.success, true, `WebSocket room join must succeed for ${room}`);
}

test('Realtime state reconciliation: lifecycle state, WebSocket events, telemetry and public tracking converge', async () => {
  assert.ok(secret.length >= 32, 'JWT secret must be at least 32 chars');
  assert.ok(databaseUrl, 'DATABASE_URL is required');

  const adminToken = token({ id: `adm_rt_${Date.now()}`, name: 'Realtime Admin', phone: '9999911111', role: 'ADMIN' });
  const driverPhone = '90000' + Math.floor(10000 + Math.random() * 90000);
  const driverCreated = await post('/api/admin/drivers/create', adminToken, {
    name: 'Realtime Driver', phone: driverPhone, vehicleId: 'v_2w', vehicleNumber: 'TS09RT1234', city: 'Hyderabad'
  });
  assert.equal(driverCreated.status, 201, 'Realtime driver creation must succeed');
  const driver = driverCreated.data.driver;
  assert.ok(driver?.id && driver?.userId, 'Realtime driver must expose profile and user ids');

  const kyc = await post('/api/admin/drivers/update-kyc', adminToken, { driverId: driver.id, kycStatus: 'APPROVED' });
  assert.equal(kyc.status, 200, 'Realtime driver KYC approval must succeed');

  const driverToken = token({ id: driver.userId, name: driver.name, phone: driver.phone, role: 'DRIVER' });
  const online = await post('/api/driver/update', driverToken, { driver_id: driver.id, status: 'ONLINE', lat: 17.3850, lng: 78.4867 });
  assert.equal(online.status, 200, 'Driver must become ONLINE before dispatch');
  const location = await post('/api/driver/location/update', driverToken, { driverId: driver.id, lat: 17.3850, lng: 78.4867, speed: 0, bearing: 0 });
  assert.equal(location.status, 200, 'Initial driver telemetry must succeed');

  const customerId = `cust_rt_${Date.now()}`;
  const customerToken = token({ id: customerId, name: 'Realtime Customer', phone: '9876509999', role: 'CUSTOMER' });
  const booking = await post('/api/trips/create', customerToken, {
    pickupLat: 17.3850,
    pickupLng: 78.4867,
    dropLat: 17.4400,
    dropLng: 78.3489,
    pickupAddress: 'Abids, Hyderabad',
    dropAddress: 'Hitec City, Hyderabad',
    vehicleId: 'v_2w',
    paymentMethod: 'CASH_ON_DELIVERY',
    idempotencyKey: `realtime-${Date.now()}`
  });
  assert.equal(booking.status, 200, 'Customer booking must succeed');
  const tripId = booking.data.trip.id;
  const trackingToken = booking.data.trip.trackingToken;
  assert.ok(tripId && trackingToken, 'Booking must return trip and tracking token');

  const customerWs = await connectWs(customerToken);
  const driverWs = await connectWs(driverToken);
  try {
    await waitForMessage(customerWs, message => message.event === 'connected');
    await waitForMessage(driverWs, message => message.event === 'connected');

    // Customer is authorized for this trip; driver is authorized only after assignment.
    await join(customerWs, `trip:${tripId}`);
    await join(driverWs, `trip:${tripId}`);

    // Driver acceptance must create a customer-visible realtime state change.
    const stateEventPromise = waitForMessage(
      customerWs,
      message => message.event === 'delivery:state_changed' && message.room === `trip:${tripId}` && message.data?.orderId === tripId
    );
    const accept = await post('/api/orders/accept', driverToken, { orderId: tripId, idempotencyKey: `realtime-accept-${tripId}` });
    assert.equal(accept.status, 200, 'Driver acceptance must succeed');

    const stateEvent = await stateEventPromise;
    assert.equal(stateEvent.data.fromState, 'DRIVER_ASSIGNED', 'Realtime event must report authoritative prior state');
    assert.equal(stateEvent.data.toState, 'DRIVER_ACCEPTED', 'Realtime event must report authoritative next state');
    assert.ok(Number.isInteger(stateEvent.data.version), 'Realtime state event must carry lifecycle version');

    const tripAfterAccept = await readTrip(tripId);
    assert.equal(tripAfterAccept.status, 'DRIVER_ACCEPTED', 'PostgreSQL state must equal realtime event state');
    assert.equal(tripAfterAccept.version, stateEvent.data.version, 'PostgreSQL version must equal realtime event version');

    const trackingResponse = await fetch(base + '/api/public/tracking/' + encodeURIComponent(trackingToken));
    assert.equal(trackingResponse.status, 200, 'Public tracking must remain available');
    const tracking = await trackingResponse.json();
    assert.equal(tracking.trip.id, tripId, 'Tracking must resolve the same trip');
    assert.equal(tracking.trip.status, tripAfterAccept.status, 'Tracking status must equal PostgreSQL state');
    assert.equal(tracking.trip.status, stateEvent.data.toState, 'Tracking status must equal realtime event state');

    // Fresh telemetry must fan out to the same trip room and carry the current trip identity.
    const locationEventPromise = waitForMessage(
      customerWs,
      message => message.event === 'LIVE_TRIP_LOCATION' && message.room === `trip:${tripId}` && message.data?.tripId === tripId
    );
    const ping = await post('/api/driver/location/update', driverToken, {
      driverId: driver.id, lat: 17.3860, lng: 78.4870, speed: 8, bearing: 90
    });
    assert.equal(ping.status, 200, 'Fresh post-accept telemetry must succeed');
    const locationEvent = await locationEventPromise;
    assert.equal(locationEvent.data.driverId, driver.id, 'Realtime location driver must match assigned driver');
    assert.equal(locationEvent.data.lat, 17.3860, 'Realtime latitude must match accepted telemetry');
    assert.equal(locationEvent.data.lng, 78.4870, 'Realtime longitude must match accepted telemetry');

    // A stale/foreign tracking token must never produce a second or conflicting state.
    const invalidTracking = await fetch(base + '/api/public/tracking/not-a-real-token');
    assert.equal(invalidTracking.status, 404, 'Invalid public tracking token must remain rejected');
  } finally {
    try { customerWs.close(); } catch (_) {}
    try { driverWs.close(); } catch (_) {}
  }
});
