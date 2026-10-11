// Automated End-to-End Enterprise Delivery Lifecycle Integration Test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require(path.join(__dirname, '..', '..', 'node_modules', 'dotenv'));
const jwt = require(path.join(__dirname, '..', '..', 'node_modules', 'jsonwebtoken'));

const envFile = path.resolve(__dirname, '..', '..', '.env');
const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const secret = process.env.VAAYU_TEST_JWT_SECRET || parsed.JWT_SECRET || '';
const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000';

function makeToken(user) {
  return jwt.sign({ id: user.id, name: user.name, phone: user.phone, role: user.role, city: 'Hyderabad' }, secret, { algorithm: 'HS256', expiresIn: 300 });
}

test('E2E: Full 12-step enterprise delivery lifecycle with geofenced telemetry and OTP verification', async () => {
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

  // 4. Create customer booking
  const customerToken = makeToken({ id: 'cust_auto_1', name: 'Ananya Sharma', phone: '9876543211', role: 'CUSTOMER' });
  const bookRes = await fetch(base + '/api/trips/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + customerToken },
    body: JSON.stringify({
      pickupLat: 17.3850,
      pickupLng: 78.4867,
      dropLat: 17.4400,
      dropLng: 78.3489,
      pickupAddress: 'Abids, Hyderabad',
      dropAddress: 'Hitec City, Hyderabad',
      vehicleId: 'v_2w',
      paymentMethod: 'CASH_ON_DELIVERY'
    })
  });
  const bookData = await bookRes.json();
  assert.equal(bookRes.status, 200, 'Trip booking must succeed');
  assert.ok(bookData.success, 'Booking success flag');
  const trip = bookData.trip;
  assert.ok(trip.pickupOtp, 'Trip must have pickup OTP');
  assert.ok(trip.deliveryOtp, 'Trip must have delivery OTP');

  // 5. Admin assigns driver to order
  const assignRes = await fetch(base + '/api/admin/dispatch/assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({ orderId: trip.id, driverId: driver.id })
  });
  const assignData = await assignRes.json();
  assert.equal(assignRes.status, 200, 'Admin assignment must succeed');
  assert.ok(assignData.success, 'Driver assignment flag');

  // 6. Driver accepts the offer
  const acceptRes = await fetch(base + '/api/orders/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id })
  });
  const acceptData = await acceptRes.json();
  assert.equal(acceptRes.status, 200, 'Driver accept must succeed');
  assert.ok(acceptData.success, 'Accept success flag');

  // 7. Driver starts arriving to pickup
  const startArriveRes = await fetch(base + '/api/orders/start-arriving', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id })
  });
  const startArriveData = await startArriveRes.json();
  assert.equal(startArriveRes.status, 200, 'Start arriving must succeed');
  assert.ok(startArriveData.success, 'Start arriving flag');

  // Telemetry ping at pickup location
  await fetch(base + '/api/driver/location/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ driverId: driver.id, lat: 17.38505, lng: 78.48672, speed: 0, bearing: 0 })
  });

  // 8. Driver arrives at pickup
  const arriveRes = await fetch(base + '/api/orders/arrived-pickup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id })
  });
  const arriveData = await arriveRes.json();
  assert.equal(arriveRes.status, 200, 'Arrived at pickup must succeed');
  assert.ok(arriveData.success, 'Arrived pickup flag');

  // 9. Confirm pickup with Pickup OTP
  const pickupRes = await fetch(base + '/api/orders/confirm-pickup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id, otp: trip.pickupOtp })
  });
  const pickupData = await pickupRes.json();
  assert.equal(pickupRes.status, 200, 'Pickup confirmation must succeed');
  assert.ok(pickupData.success, 'Pickup confirmation flag');

  // 10. Start transit
  const transitRes = await fetch(base + '/api/orders/start-transit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id })
  });
  const transitData = await transitRes.json();
  assert.equal(transitRes.status, 200, 'Start transit must succeed');
  assert.ok(transitData.success, 'Start transit flag');

  // Telemetry ping at destination with realistic bypass flag
  await fetch(base + '/api/driver/location/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ driverId: driver.id, lat: 17.44002, lng: 78.34891, speed: 0, bearing: 270, bypassSpeedFilter: true })
  });

  // 11. Arrive at dropoff
  const dropRes = await fetch(base + '/api/orders/arrived-dropoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id })
  });
  const dropData = await dropRes.json();
  assert.equal(dropRes.status, 200, 'Arrived at dropoff must succeed');
  assert.ok(dropData.success, 'Arrived dropoff flag');

  // 12. Complete delivery with Delivery OTP + receiverName
  const completeRes = await fetch(base + '/api/orders/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + driverToken },
    body: JSON.stringify({
      orderId: trip.id,
      otp: trip.deliveryOtp,
      proof: {
        receiverName: 'Ananya Sharma'
      }
    })
  });
  const completeData = await completeRes.json();
  assert.equal(completeRes.status, 200, 'Complete delivery must succeed');
  assert.ok(completeData.success, 'Complete delivery flag');
  assert.equal(completeData.status || completeData.trip?.status, 'DELIVERED', 'Terminal state must be DELIVERED');
});
