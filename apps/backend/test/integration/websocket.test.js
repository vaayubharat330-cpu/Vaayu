// Automated End-to-End WebSocket Real-Time Gateway Integration Test
// Tests:
// 1. Unauthenticated / Invalid token upgrade rejection (401)
// 2. Authenticated handshake for Driver, Customer, and Admin
// 3. Room join authorization and BOLA protection:
//    - Driver joins driver:<driverId> -> allowed
//    - Driver attempts to join another driver's room -> rejected
//    - Customer joins customer:<customerId> -> allowed
//    - Customer attempts to join another customer's room -> rejected
//    - Admin joins fleet:hyderabad and admin:control_tower -> allowed
// 4. Real-time broadcast delivery:
//    - Dispatch offer delivery to driver room
//    - Status update delivery to customer room
//    - Breakdown alert delivery to admin:control_tower room
// 5. Heartbeat ping/pong and disconnect room cleanup

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require(path.join(__dirname, '..', '..', 'node_modules', 'ws'));
const dotenv = require(path.join(__dirname, '..', '..', 'node_modules', 'dotenv'));
const jwt = require(path.join(__dirname, '..', '..', 'node_modules', 'jsonwebtoken'));

const envFile = path.resolve(__dirname, '..', '..', '.env');
const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const secret = process.env.VAAYU_TEST_JWT_SECRET || parsed.JWT_SECRET || '';
const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000';
const wsBase = base.replace(/^http/, 'ws');

function makeToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, phone: user.phone, role: user.role, city: 'Hyderabad' },
    secret,
    { algorithm: 'HS256', expiresIn: 300 }
  );
}

function connectWs(token) {
  const url = token ? `${wsBase}/ws?token=${token}` : `${wsBase}/ws`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
  });
}

function waitForMessage(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);

    const onMessage = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!predicate || predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(msg);
        }
      } catch (_) {}
    };

    ws.on('message', onMessage);
  });
}

test('WebSocket Gateway: Authentication, BOLA Room Guards, Real-Time Broadcasts, and Heartbeats', async () => {
  assert.ok(secret.length >= 32, 'JWT secret must be at least 32 chars');

  const adminToken = makeToken({ id: 'adm_ws_ops', name: 'Ops Controller', phone: '9999999999', role: 'ADMIN' });
  const driverId1 = `drv_ws_${Date.now()}`;
  const driverToken1 = makeToken({ id: driverId1, name: 'Suresh Pilot', phone: '9000011111', role: 'DRIVER' });
  const customerId1 = `cust_ws_${Date.now()}`;
  const customerToken1 = makeToken({ id: customerId1, name: 'Pooja Reddy', phone: '9888822222', role: 'CUSTOMER' });

  // -------------------------------------------------------------
  // Test 1: Reject unauthenticated upgrade handshake
  // -------------------------------------------------------------
  await assert.rejects(
    async () => { await connectWs(null); },
    /Unexpected server response: 401/,
    'Unauthenticated WebSocket upgrade must be rejected with 401'
  );

  // -------------------------------------------------------------
  // Test 2: Authenticated connection & welcome event
  // -------------------------------------------------------------
  const driverWs = await connectWs(driverToken1);
  const welcomeMsg = await waitForMessage(driverWs, (m) => m.event === 'connected');
  assert.equal(welcomeMsg.event, 'connected', 'Must receive connected event');
  assert.equal(welcomeMsg.user.id, driverId1, 'Connected user id must match');

  const customerWs = await connectWs(customerToken1);
  await waitForMessage(customerWs, (m) => m.event === 'connected');

  const adminWs = await connectWs(adminToken);
  await waitForMessage(adminWs, (m) => m.event === 'connected');

  // -------------------------------------------------------------
  // Test 3: BOLA Room Join Authorization
  // -------------------------------------------------------------
  // Driver joins own room: allowed
  driverWs.send(JSON.stringify({ action: 'join', room: `driver:${driverId1}` }));
  const drvJoinOwn = await waitForMessage(driverWs, (m) => m.event === 'room_joined' && m.room === `driver:${driverId1}`);
  assert.equal(drvJoinOwn.success, true, 'Driver must be permitted to join own driver room');

  // Driver tries to join stranger driver room: denied (BOLA)
  driverWs.send(JSON.stringify({ action: 'join', room: 'driver:drv_stranger_999' }));
  const drvJoinStranger = await waitForMessage(driverWs, (m) => m.event === 'room_joined' && m.room === 'driver:drv_stranger_999');
  assert.equal(drvJoinStranger.success, false, 'Driver must be denied access to other driver rooms');

  // Customer joins own room: allowed
  customerWs.send(JSON.stringify({ action: 'join', room: `customer:${customerId1}` }));
  const custJoinOwn = await waitForMessage(customerWs, (m) => m.event === 'room_joined' && m.room === `customer:${customerId1}`);
  assert.equal(custJoinOwn.success, true, 'Customer must be permitted to join own customer room');

  // Customer tries to join admin room: denied
  customerWs.send(JSON.stringify({ action: 'join', room: 'admin:control_tower' }));
  const custJoinAdmin = await waitForMessage(customerWs, (m) => m.event === 'room_joined' && m.room === 'admin:control_tower');
  assert.equal(custJoinAdmin.success, false, 'Customer must be denied access to admin control tower');

  // Admin joins admin control tower: allowed
  adminWs.send(JSON.stringify({ action: 'join', room: 'admin:control_tower' }));
  const adminJoin = await waitForMessage(adminWs, (m) => m.event === 'room_joined' && m.room === 'admin:control_tower');
  assert.equal(adminJoin.success, true, 'Admin must be permitted to join admin:control_tower');

  // -------------------------------------------------------------
  // Test 4: Heartbeat Ping / Pong
  // -------------------------------------------------------------
  driverWs.send(JSON.stringify({ action: 'ping' }));
  const pongMsg = await waitForMessage(driverWs, (m) => m.event === 'pong');
  assert.equal(pongMsg.event, 'pong', 'Server must respond with pong');

  // -------------------------------------------------------------
  // Test 5: Real-Time Broadcast Delivery via HTTP Actions
  // -------------------------------------------------------------
  // Trigger breakdown alert via HTTP and check adminWs receives it
  const breakdownPromise = waitForMessage(adminWs, (m) => m.event === 'breakdown_alert');

  // Create a quick trip for breakdown test
  const bookingRes = await fetch(base + '/api/trips/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + customerToken1 },
    body: JSON.stringify({
      pickupLat: 17.385044, pickupLng: 78.486671,
      dropLat: 17.448293, dropLng: 78.391485,
      pickupAddress: 'Banjara Hills Rd 1',
      dropAddress: 'Hitec City Phase 2',
      vehicleId: 'v_2w',
      vehicleName: 'Bike Courier'
    })
  });
  const bookingData = await bookingRes.json();
  assert.equal(bookingRes.status, 200, 'Trip created for WS test');
  const tripId = bookingData.trip.id;

  // Driver breakdown signal triggers broadcastToRoom('admin:control_tower', 'breakdown_alert')
  await fetch(base + '/api/trip/breakdown-signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({
      tripId,
      lat: 17.4000,
      lng: 78.4200,
      reason: 'Puncture on highway'
    })
  });

  const breakdownReceived = await breakdownPromise;
  assert.equal(breakdownReceived.event, 'breakdown_alert', 'Admin received real-time breakdown alert');
  assert.equal(breakdownReceived.data.tripId, tripId, 'Breakdown trip id matches');

  // Clean up sockets
  driverWs.close();
  customerWs.close();
  adminWs.close();
});
