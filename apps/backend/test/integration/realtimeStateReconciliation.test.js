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

async function request(method, url, auth, body) {
  const options = { method, headers: {} };
  if (auth) options.headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(base + url, options);
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  return { status: response.status, data, headers: response.headers };
}

async function post(url, auth, body) {
  return request('POST', url, auth, body);
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

test('Realtime state reconciliation: customer, driver, admin, PostgreSQL, WebSocket and public tracking converge', async () => {
  assert.ok(secret.length >= 32, 'JWT secret must be at least 32 chars');
  assert.ok(databaseUrl, 'DATABASE_URL is required');

  const suffix = Date.now();
  const adminToken = token({ id: `adm_rt_${suffix}`, name: 'Realtime Admin', phone: '9999911111', role: 'ADMIN' });
  const driverPhone = '90000' + Math.floor(10000 + Math.random() * 90000);
  const driverCreated = await post('/api/admin/drivers/create', adminToken, {
    name: 'Realtime Driver', phone: driverPhone, vehicleId: 'v_2w', vehicleNumber: `TS09RT${String(suffix).slice(-4)}`, city: 'Hyderabad'
  });
  assert.equal(driverCreated.status, 201, 'Realtime driver creation must succeed');
  const driver = driverCreated.data.driver;
  assert.ok(driver?.id && driver?.userId, 'Realtime driver must expose profile and user ids');

  const kyc = await post('/api/admin/drivers/update-kyc', adminToken, { driverId: driver.id, kycStatus: 'APPROVED' });
  assert.equal(kyc.status, 200, 'Realtime driver KYC approval must succeed');

  const driverToken = token({ id: driver.userId, name: driver.name, phone: driver.phone, role: 'DRIVER' });
  assert.equal((await post('/api/driver/update', driverToken, { driver_id: driver.id, status: 'ONLINE', lat: 17.3850, lng: 78.4867 })).status, 200, 'Driver must become ONLINE before dispatch');
  assert.equal((await post('/api/driver/location/update', driverToken, { driverId: driver.id, lat: 17.3850, lng: 78.4867, speed: 0, bearing: 0 })).status, 200, 'Initial driver telemetry must succeed');

  const customerId = `cust_rt_${suffix}`;
  const customerToken = token({ id: customerId, name: 'Realtime Customer', phone: `98765${String(suffix).slice(-5)}`, role: 'CUSTOMER' });
  const booking = await post('/api/trips/create', customerToken, {
    pickupLat: 17.3850, pickupLng: 78.4867, dropLat: 17.4400, dropLng: 78.3489,
    pickupAddress: 'Abids, Hyderabad', dropAddress: 'Hitec City, Hyderabad', vehicleId: 'v_2w',
    paymentMethod: 'CASH_ON_DELIVERY', idempotencyKey: `realtime-${suffix}`
  });
  assert.equal(booking.status, 200, 'Customer booking must succeed');
  const tripId = booking.data.trip.id;
  const trackingToken = booking.data.trip.trackingToken;
  assert.ok(tripId && trackingToken, 'Booking must return trip and tracking token');

  // Role-surface convergence before any lifecycle transition.
  const customerTrip = await request('GET', `/api/trips/${encodeURIComponent(tripId)}`, customerToken);
  assert.equal(customerTrip.status, 200, 'Customer must read its own authoritative trip');
  assert.equal(customerTrip.data.trip.id, tripId);
  assert.equal(customerTrip.data.trip.status, 'DRIVER_ASSIGNED');

  const customerHistory = await request('GET', '/api/trips/history?status=ACTIVE', customerToken);
  assert.equal(customerHistory.status, 200, 'Customer active-trip history must be readable');
  assert.ok(customerHistory.data.activeTrips.some(item => item.id === tripId), 'Customer history must contain the same active trip');

  const driverTrip = await request('GET', `/api/trips/${encodeURIComponent(tripId)}`, driverToken);
  assert.equal(driverTrip.status, 200, 'Assigned driver must read the same trip');
  assert.equal(driverTrip.data.trip.id, tripId);
  assert.equal(driverTrip.data.trip.driver?.id || driverTrip.data.trip.driverId, driver.id);

  const adminActive = await request('GET', '/api/admin/trips/active', adminToken);
  assert.equal(adminActive.status, 200, 'Admin active-trip projection must be readable');
  const adminTrip = adminActive.data.activeTrips.find(item => item.id === tripId);
  assert.ok(adminTrip, 'Admin must see the same active trip');
  assert.equal(adminTrip.status, 'DRIVER_ASSIGNED');
  assert.equal(adminTrip.driver?.id || adminTrip.driverId, driver.id);

  const otherCustomerToken = token({ id: `cust_other_rt_${suffix}`, name: 'Other Customer', phone: `97777${String(suffix).slice(-5)}`, role: 'CUSTOMER' });
  const unauthorizedTrip = await request('GET', `/api/trips/${encodeURIComponent(tripId)}`, otherCustomerToken);
  assert.equal(unauthorizedTrip.status, 403, 'A different customer must not read the trip object');
  assert.equal(unauthorizedTrip.data.error?.code, 'FORBIDDEN_OBJECT_ACCESS');

  const customerWs = await connectWs(customerToken);
  const driverWs = await connectWs(driverToken);
  try {
    await waitForMessage(customerWs, message => message.event === 'connected');
    await waitForMessage(driverWs, message => message.event === 'connected');
    await join(customerWs, `trip:${tripId}`);
    await join(driverWs, `trip:${tripId}`);

    const stateEventPromise = waitForMessage(
      customerWs,
      message => message.event === 'delivery:state_changed' && message.room === `trip:${tripId}` && message.data?.orderId === tripId
    );
    const accept = await post('/api/orders/accept', driverToken, { orderId: tripId, idempotencyKey: `realtime-accept-${tripId}` });
    assert.equal(accept.status, 200, 'Driver acceptance must succeed');

    const stateEvent = await stateEventPromise;
    assert.equal(stateEvent.data.fromState, 'DRIVER_ASSIGNED');
    assert.equal(stateEvent.data.toState, 'DRIVER_ACCEPTED');
    assert.ok(Number.isInteger(stateEvent.data.version));

    const tripAfterAccept = await readTrip(tripId);
    assert.equal(tripAfterAccept.status, 'DRIVER_ACCEPTED', 'PostgreSQL state must equal realtime event state');
    assert.equal(tripAfterAccept.version, stateEvent.data.version, 'PostgreSQL version must equal realtime event version');

    // Re-read every authenticated operational surface after the transition.
    const customerAfter = await request('GET', `/api/trips/${encodeURIComponent(tripId)}`, customerToken);
    assert.equal(customerAfter.status, 200);
    assert.equal(customerAfter.data.trip.status, tripAfterAccept.status);
    assert.equal(customerAfter.data.trip.version, tripAfterAccept.version);

    const driverAfter = await request('GET', `/api/trips/${encodeURIComponent(tripId)}`, driverToken);
    assert.equal(driverAfter.status, 200);
    assert.equal(driverAfter.data.trip.status, tripAfterAccept.status);
    assert.equal(driverAfter.data.trip.version, tripAfterAccept.version);

    const adminAfterResponse = await request('GET', '/api/admin/trips/active', adminToken);
    assert.equal(adminAfterResponse.status, 200);
    const adminAfter = adminAfterResponse.data.activeTrips.find(item => item.id === tripId);
    assert.ok(adminAfter, 'Admin must retain the same trip after acceptance');
    assert.equal(adminAfter.status, tripAfterAccept.status);
    assert.equal(adminAfter.version, tripAfterAccept.version);

    const trackingResponse = await fetch(base + '/api/public/tracking/' + encodeURIComponent(trackingToken));
    assert.equal(trackingResponse.status, 200, 'Public tracking must remain available');
    const tracking = await trackingResponse.json();
    assert.equal(tracking.trip.id, tripId);
    assert.equal(tracking.trip.status, tripAfterAccept.status);
    assert.equal(tracking.trip.status, stateEvent.data.toState);

    const locationEventPromise = waitForMessage(
      customerWs,
      message => message.event === 'LIVE_TRIP_LOCATION' && message.room === `trip:${tripId}` && message.data?.tripId === tripId
    );
    const ping = await post('/api/driver/location/update', driverToken, {
      driverId: driver.id, lat: 17.3860, lng: 78.4870, speed: 8, bearing: 90
    });
    assert.equal(ping.status, 200, 'Fresh post-accept telemetry must succeed');
    const locationEvent = await locationEventPromise;
    assert.equal(locationEvent.data.driverId, driver.id);
    assert.equal(locationEvent.data.lat, 17.3860);
    assert.equal(locationEvent.data.lng, 78.4870);

    const invalidTracking = await fetch(base + '/api/public/tracking/not-a-real-token');
    assert.equal(invalidTracking.status, 404, 'Invalid public tracking token must remain rejected');
  } finally {
    try { customerWs.close(); } catch (_) {}
    try { driverWs.close(); } catch (_) {}
  }
});
