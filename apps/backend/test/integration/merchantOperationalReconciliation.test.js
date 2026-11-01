'use strict';

// Cross-role certification:
// Customer -> Merchant account -> Merchant batch booking -> Dispatch/Driver ->
// authoritative trip state -> Merchant order projection -> PostgreSQL -> POD.
// The purpose is to prove that the merchant-facing representation is not a detached
// shadow of the core trip state machine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require(path.join(__dirname, '..', '..', 'node_modules', 'dotenv'));
const jwt = require(path.join(__dirname, '..', '..', 'node_modules', 'jsonwebtoken'));
const { PostgresPool } = require('../../src/db/postgresClient');

const envFile = path.resolve(__dirname, '..', '..', '.env');
const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const secret = process.env.VAAYU_TEST_JWT_SECRET || parsed.JWT_SECRET || '';
const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000';
const databaseUrl = process.env.DATABASE_URL || parsed.DATABASE_URL || '';

function token(user) {
  return jwt.sign({ ...user, city: 'Hyderabad' }, secret, { algorithm: 'HS256', expiresIn: 900 });
}

async function request(method, url, auth, body) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  return { status: response.status, data, headers: response.headers };
}

async function readTrip(pool, tripId) {
  const result = await pool.query(
    "SELECT data FROM vaayu_records WHERE collection='trips' AND record_key=$1",
    [`id:${tripId}`]
  );
  assert.equal(result.rows.length, 1, `PostgreSQL must contain authoritative trip ${tripId}`);
  return result.rows[0].data;
}

test('Merchant operational reconciliation: merchant order, driver lifecycle, admin state, PostgreSQL and POD converge', async (t) => {
  assert.ok(secret.length >= 32, 'JWT secret must be at least 32 chars');
  assert.ok(databaseUrl, 'DATABASE_URL is required');

  const suffix = Date.now();
  const pool = new PostgresPool({ connectionString: databaseUrl });
  t.after(async () => { await pool.end(); });

  const adminToken = token({
    id: `adm_merch_cert_${suffix}`,
    name: 'Merchant Reconciliation Admin',
    phone: '9999944444',
    role: 'ADMIN'
  });

  // 1. Create a real dispatch-eligible driver and establish canonical telemetry.
  const driverPhone = `90777${String(suffix).slice(-5)}`;
  const createdDriver = await request('POST', '/api/admin/drivers/create', adminToken, {
    name: 'Merchant Reconciliation Driver',
    phone: driverPhone,
    vehicleId: 'v_ace',
    vehicleNumber: `TS09MR${String(suffix).slice(-4)}`,
    city: 'Hyderabad'
  });
  assert.equal(createdDriver.status, 201, JSON.stringify(createdDriver.data));
  const driver = createdDriver.data.driver;
  assert.ok(driver?.id && driver?.userId);

  const approved = await request('POST', '/api/admin/drivers/update-kyc', adminToken, {
    driverId: driver.id,
    kycStatus: 'APPROVED'
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));

  const driverToken = token({ id: driver.userId, name: driver.name, phone: driver.phone, role: 'DRIVER' });
  assert.equal((await request('POST', '/api/driver/update', driverToken, {
    driver_id: driver.id, status: 'ONLINE', lat: 17.3850, lng: 78.4867
  })).status, 200);
  assert.equal((await request('POST', '/api/driver/location/update', driverToken, {
    driverId: driver.id, lat: 17.3850, lng: 78.4867, speed: 0, bearing: 0
  })).status, 200);

  // 2. A verified customer identity creates the merchant account. The returned merchant JWT
  // becomes the authoritative identity for every subsequent /api/merchant/* call.
  const customerId = `cust_merchant_cert_${suffix}`;
  const customerPhone = `98888${String(suffix).slice(-5)}`;
  const customerToken = token({
    id: customerId,
    name: 'Merchant Registration Customer',
    phone: customerPhone,
    role: 'CUSTOMER'
  });
  const merchantRegistration = await request('POST', '/api/merchant/register', customerToken, {
    phone: customerPhone,
    businessName: `VAAYU Certification Merchant ${suffix}`,
    contactName: 'Merchant Certification Owner',
    email: `merchant-cert-${suffix}@example.com`,
    gstin: '36ABCDE1234F1Z5',
    address: 'Hyderabad, Telangana'
  });
  assert.equal(merchantRegistration.status, 200, JSON.stringify(merchantRegistration.data));
  assert.equal(merchantRegistration.data.success, true);
  const merchant = merchantRegistration.data.merchant;
  const merchantToken = merchantRegistration.data.token;
  assert.ok(merchant?.id && merchantToken, 'Merchant registration must return an authenticated merchant identity');

  const merchantProfile = await request('GET', '/api/merchant/profile', merchantToken);
  assert.equal(merchantProfile.status, 200, JSON.stringify(merchantProfile.data));
  assert.equal(merchantProfile.data.merchant.id, merchant.id);

  // 3. Merchant creates a real B2B shipment. Batch booking must dispatch the shipment and
  // preserve the business order reference in the authoritative trip record.
  const businessOrderId = `B2B-${suffix}`;
  const batch = await request('POST', '/api/merchant/batch-booking', merchantToken, {
    idempotencyKey: `MERCHANT-CERT:${suffix}:BOOK`,
    businessOrderId,
    poReference: `PO-${suffix}`,
    bookings: [{
      pickupLat: 17.3850,
      pickupLng: 78.4867,
      dropLat: 17.4400,
      dropLng: 78.3489,
      pickupAddress: 'Abids, Hyderabad',
      dropAddress: 'Hitec City, Hyderabad',
      vehicleId: 'v_ace',
      businessOrderId,
      poReference: `PO-${suffix}`,
      senderName: 'Merchant Certification Sender'
    }]
  });
  assert.equal(batch.status, 200, JSON.stringify(batch.data));
  assert.equal(batch.data.success, true, JSON.stringify(batch.data));
  assert.equal(Array.isArray(batch.data.trips), true);
  assert.equal(batch.data.trips.length, 1);
  const tripId = batch.data.trips[0].id;
  assert.ok(tripId);

  const tripAfterBooking = await readTrip(pool, tripId);
  assert.equal(tripAfterBooking.merchantId || tripAfterBooking.merchant_id, merchant.id);
  assert.equal(tripAfterBooking.businessOrderId || tripAfterBooking.business_order_id, businessOrderId);
  assert.ok(tripAfterBooking.trackingToken);

  const dispatchResult = (batch.data.dispatch || [])[0];
  assert.equal(dispatchResult?.assignedDriver?.driverId, driver.id, JSON.stringify(batch.data));
  assert.equal(tripAfterBooking.driver?.id || tripAfterBooking.driverId, driver.id);

  // 4. Merchant projection must expose the same shipment identity/status as PostgreSQL.
  const merchantOrders = await request('GET', '/api/merchant/orders', merchantToken);
  assert.equal(merchantOrders.status, 200, JSON.stringify(merchantOrders.data));
  const merchantOrder = (merchantOrders.data.orders || []).find(order => order.id === tripId);
  assert.ok(merchantOrder, 'Merchant order projection must contain the newly booked shipment');
  assert.equal(merchantOrder.id, tripId);
  assert.equal(merchantOrder.status, tripAfterBooking.status);

  // 5. Driver advances the authoritative lifecycle. Every meaningful transition is checked
  // against PostgreSQL so the merchant projection can never be treated as the source of truth.
  const accept = await request('POST', '/api/orders/accept', driverToken, {
    orderId: tripId,
    idempotencyKey: `MERCHANT-CERT:${tripId}:ACCEPT`
  });
  assert.equal(accept.status, 200, JSON.stringify(accept.data));

  assert.equal((await request('POST', '/api/orders/start-arriving', driverToken, {
    orderId: tripId,
    idempotencyKey: `MERCHANT-CERT:${tripId}:ARRIVING`
  })).status, 200);

  assert.equal((await request('POST', '/api/driver/location/update', driverToken, {
    driverId: driver.id, lat: 17.3850, lng: 78.4867, speed: 0, bearing: 0
  })).status, 200);
  assert.equal((await request('POST', '/api/orders/arrived-pickup', driverToken, {
    orderId: tripId,
    idempotencyKey: `MERCHANT-CERT:${tripId}:PICKUP`
  })).status, 200);

  let trip = await readTrip(pool, tripId);
  assert.equal(trip.status, 'DRIVER_AT_PICKUP');
  const pickupOtp = String(trip.pickupOtp);
  const deliveryOtp = String(trip.deliveryOtp);

  assert.equal((await request('POST', '/api/orders/confirm-pickup', driverToken, {
    orderId: tripId,
    otp: pickupOtp,
    idempotencyKey: `MERCHANT-CERT:${tripId}:PICKUP_CONFIRM`
  })).status, 200);
  assert.equal((await request('POST', '/api/orders/start-transit', driverToken, {
    orderId: tripId,
    idempotencyKey: `MERCHANT-CERT:${tripId}:TRANSIT`
  })).status, 200);

  assert.equal((await request('POST', '/api/driver/location/update', driverToken, {
    driverId: driver.id, lat: 17.4400, lng: 78.3489, speed: 0, bearing: 0
  })).status, 200);
  assert.equal((await request('POST', '/api/orders/arrived-dropoff', driverToken, {
    orderId: tripId,
    idempotencyKey: `MERCHANT-CERT:${tripId}:DROPOFF`
  })).status, 200);

  const complete = await request('POST', '/api/orders/complete', driverToken, {
    orderId: tripId,
    otp: deliveryOtp,
    proof: { receiverName: 'Merchant Certification Receiver' },
    idempotencyKey: `MERCHANT-CERT:${tripId}:COMPLETE`
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.data));

  trip = await readTrip(pool, tripId);
  assert.equal(trip.status, 'DELIVERED');
  assert.equal(trip.driver?.id || trip.driverId, driver.id);
  assert.equal(trip.merchantId || trip.merchant_id, merchant.id);
  assert.equal(trip.proofOfDelivery?.receiverName, 'Merchant Certification Receiver');

  // 6. Merchant orders must converge to the same terminal state and identity.
  const finalOrders = await request('GET', '/api/merchant/orders', merchantToken);
  assert.equal(finalOrders.status, 200, JSON.stringify(finalOrders.data));
  const finalOrder = (finalOrders.data.orders || []).find(order => order.id === tripId);
  assert.ok(finalOrder, 'Delivered shipment must remain visible to its merchant');
  assert.equal(finalOrder.status, 'DELIVERED');
  assert.equal(finalOrder.id, trip.id);
  assert.equal(finalOrder.businessOrderId || finalOrder.business_order_id, businessOrderId);

  // 7. Merchant-only POD access must succeed for the owning merchant and must not leak to another merchant.
  const pod = await request('GET', `/api/merchant/pod/${encodeURIComponent(tripId)}`, merchantToken);
  assert.equal(pod.status, 200, `Merchant POD must be available after delivery: ${JSON.stringify(pod.data)}`);
  assert.equal(pod.headers.get('content-type'), 'application/pdf');
  assert.ok(Number(pod.headers.get('content-length')) > 0);

  const otherMerchantCustomerToken = token({
    id: `cust_other_merchant_${suffix}`,
    name: 'Other Merchant Customer',
    phone: `97777${String(suffix).slice(-5)}`,
    role: 'CUSTOMER'
  });
  const otherRegistration = await request('POST', '/api/merchant/register', otherMerchantCustomerToken, {
    phone: `97777${String(suffix).slice(-5)}`,
    businessName: `Other Certification Merchant ${suffix}`,
    contactName: 'Other Owner',
    email: `other-merchant-${suffix}@example.com`,
    address: 'Hyderabad, Telangana'
  });
  assert.equal(otherRegistration.status, 200, JSON.stringify(otherRegistration.data));
  const otherPod = await request('GET', `/api/merchant/pod/${encodeURIComponent(tripId)}`, otherRegistration.data.token);
  assert.equal(otherPod.status, 404, 'A merchant must never read another merchant\'s POD');

  // 8. Admin active-trip projection must converge too: a delivered shipment is no longer active.
  const adminActive = await request('GET', '/api/admin/trips/active', adminToken);
  assert.equal(adminActive.status, 200, JSON.stringify(adminActive.data));
  assert.equal((adminActive.data.activeTrips || []).some(item => item.id === tripId), false);
});
