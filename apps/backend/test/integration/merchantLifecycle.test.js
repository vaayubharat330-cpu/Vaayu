// Automated B2B vertical-slice integration test.
// Proves the merchant-originated command reaches automatic dispatch, durable merchant
// projection, recipient tracking, and the operations control-tower projection.
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
  return jwt.sign(
    { id: user.id, name: user.name, phone: user.phone, role: user.role, city: 'Hyderabad' },
    secret,
    { algorithm: 'HS256', expiresIn: 300 }
  );
}

async function jsonRequest(pathname, options = {}) {
  const response = await fetch(base + pathname, options);
  const body = await response.json();
  return { response, body };
}

test('E2E: Merchant booking -> dispatch -> driver accept -> recipient tracking -> operations projection', async () => {
  assert.ok(secret.length >= 32, 'JWT secret must be at least 32 chars');

  const adminToken = makeToken({ id: 'adm_merchant_e2e', name: 'Ops Admin', phone: '9999999998', role: 'ADMIN' });

  // 1. Create and approve an eligible driver through the real admin HTTP surface.
  const driverPhone = '90100' + Math.floor(10000 + Math.random() * 90000);
  const { response: createDriverRes, body: driverData } = await jsonRequest('/api/admin/drivers/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
    body: JSON.stringify({ name: 'Merchant Slice Driver', phone: driverPhone, vehicleId: 'v_2w', vehicleNumber: 'TS09UC' + Math.floor(1000 + Math.random() * 9000), city: 'Hyderabad' })
  });
  assert.equal(createDriverRes.status, 201);
  assert.ok(driverData.success);
  const driver = driverData.driver;

  const { response: kycRes, body: kycData } = await jsonRequest('/api/admin/drivers/update-kyc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
    body: JSON.stringify({ driverId: driver.id, kycStatus: 'APPROVED' })
  });
  assert.equal(kycRes.status, 200);
  assert.ok(kycData.success);

  const driverToken = makeToken({ id: driver.userId, name: driver.name, phone: driver.phone, role: 'DRIVER' });
  const { response: onlineRes, body: onlineData } = await jsonRequest('/api/driver/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + driverToken },
    body: JSON.stringify({ driver_id: driver.id, status: 'ONLINE', lat: 17.3850, lng: 78.4867 })
  });
  assert.equal(onlineRes.status, 200);
  assert.ok(onlineData.success);

  // 2. Register the merchant through the customer->merchant onboarding boundary.
  const merchantPhone = '90200' + Math.floor(10000 + Math.random() * 90000);
  const merchantOwnerToken = makeToken({ id: `cust_merchant_${Date.now()}`, name: 'Merchant Owner', phone: merchantPhone, role: 'CUSTOMER' });
  const { response: registerRes, body: registerData } = await jsonRequest('/api/merchant/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + merchantOwnerToken },
    body: JSON.stringify({
      businessName: 'B2B Slice Commerce',
      contactName: 'Merchant Owner',
      phone: merchantPhone,
      businessType: 'RETAIL',
      city: 'Hyderabad'
    })
  });
  assert.equal(registerRes.status, 200);
  assert.ok(registerData.success);
  assert.ok(registerData.merchant?.id);
  assert.ok(registerData.token);
  const merchantToken = 'Bearer ' + registerData.token;

  // 3. Submit a genuine merchant batch-booking command with idempotency.
  const bookingIdempotencyKey = `merchant-e2e-${Date.now()}`;
  const bookingPayload = {
    idempotencyKey: bookingIdempotencyKey,
    businessOrderId: `BO-${Date.now()}`,
    poReference: 'PO-E2E-001',
    bookings: [{
      pickupLat: 17.3850,
      pickupLng: 78.4867,
      dropLat: 17.4400,
      dropLng: 78.3489,
      pickupAddress: 'Abids, Hyderabad',
      dropAddress: 'Hitec City, Hyderabad',
      vehicleId: 'v_2w',
      vehicleName: 'VAAYU Express (2W)',
      recipientName: 'B2B Recipient',
      recipientPhone: '9030012345',
      cargoDescription: 'Commercial parcel',
      helperCount: 0
    }]
  };

  const { response: bookingRes, body: bookingData } = await jsonRequest('/api/merchant/batch-booking', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: merchantToken,
      'X-Idempotency-Key': bookingIdempotencyKey
    },
    body: JSON.stringify(bookingPayload)
  });
  assert.equal(bookingRes.status, 200);
  assert.ok(bookingData.success, JSON.stringify(bookingData));
  assert.equal(bookingData.trips?.length, 1);
  assert.ok(bookingData.trips[0].id);
  const trip = bookingData.trips[0];
  assert.equal(bookingData.dispatch?.[0]?.success, true, 'Merchant command must trigger automatic dispatch');
  assert.equal(bookingData.dispatch[0].assignedDriver?.driverId, driver.id);
  assert.equal(trip.merchantId, registerData.merchant.id, 'Trip must remain associated with the authorized merchant');

  // 4. Replay the same merchant command. It must not create another shipment.
  const { response: replayRes, body: replayData } = await jsonRequest('/api/merchant/batch-booking', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: merchantToken,
      'X-Idempotency-Key': bookingIdempotencyKey
    },
    body: JSON.stringify(bookingPayload)
  });
  assert.equal(replayRes.status, 200);
  assert.ok(replayData.success);
  assert.equal(replayData.trips?.[0]?.id, trip.id, 'Merchant idempotent replay must return the original trip');

  // 5. Merchant projection must return the new shipment for the authenticated tenant.
  const { response: ordersRes, body: ordersData } = await jsonRequest('/api/merchant/orders', {
    headers: { Authorization: merchantToken }
  });
  assert.equal(ordersRes.status, 200);
  assert.ok(ordersData.success);
  assert.ok((ordersData.orders || []).some(order => order.id === trip.id), 'Merchant order projection must contain the shipment');

  // 6. Recipient projection must resolve by the durable tracking token and never leak delivery OTP.
  assert.ok(trip.trackingToken, 'Merchant-created trip must have a tracking token');
  const { response: trackingRes, body: trackingData } = await jsonRequest('/api/public/tracking/' + encodeURIComponent(trip.trackingToken));
  assert.equal(trackingRes.status, 200);
  assert.ok(trackingData.success);
  assert.equal(trackingData.trip?.id, trip.id);
  assert.equal(Object.prototype.hasOwnProperty.call(trackingData.trip || {}, 'deliveryOtp'), false);

  // 7. Control Tower must see both the live fleet and the active shipment projection.
  const { response: fleetRes, body: fleetData } = await jsonRequest('/api/admin/fleet/live', {
    headers: { Authorization: 'Bearer ' + adminToken }
  });
  assert.equal(fleetRes.status, 200);
  assert.ok(fleetData.success);
  const fleetDriver = (fleetData.drivers || []).find(d => d.driverId === driver.id);
  assert.ok(fleetDriver, 'Control Tower fleet projection must include the online driver');
  assert.equal(fleetDriver.livenessState, 'ONLINE');

  const { response: activeRes, body: activeData } = await jsonRequest('/api/admin/trips/active', {
    headers: { Authorization: 'Bearer ' + adminToken }
  });
  assert.equal(activeRes.status, 200);
  assert.ok(activeData.success);
  const activeTrip = (activeData.activeTrips || []).find(t => t.id === trip.id);
  assert.ok(activeTrip, 'Control Tower active-trip projection must include the merchant shipment');
  assert.equal(activeTrip.status, 'DRIVER_ASSIGNED');
  assert.equal(activeTrip.reservationLockActive, true);

  // 8. The assigned driver can consume the same authoritative offer through the driver command surface.
  const { response: acceptRes, body: acceptData } = await jsonRequest('/api/orders/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + driverToken },
    body: JSON.stringify({ orderId: trip.id, idempotencyKey: `merchant-e2e-accept-${trip.id}` })
  });
  assert.equal(acceptRes.status, 200);
  assert.ok(acceptData.success);

  // 9. Control Tower projection must reconcile the state transition rather than retaining DRIVER_ASSIGNED.
  const { response: activeAfterAcceptRes, body: activeAfterAcceptData } = await jsonRequest('/api/admin/trips/active', {
    headers: { Authorization: 'Bearer ' + adminToken }
  });
  assert.equal(activeAfterAcceptRes.status, 200);
  const activeAfterAccept = (activeAfterAcceptData.activeTrips || []).find(t => t.id === trip.id);
  assert.ok(activeAfterAccept);
  assert.equal(activeAfterAccept.status, 'DRIVER_ACCEPTED');
});
