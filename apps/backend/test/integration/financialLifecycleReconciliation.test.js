'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require(path.join(__dirname, '..', '..', 'node_modules', 'dotenv'));
const jwt = require(path.join(__dirname, '..', '..', 'node_modules', 'jsonwebtoken'));
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { runMigrations } = require('../../src/db/runLedgerMigrations');

const envFile = path.resolve(__dirname, '..', '..', '.env');
const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const secret = process.env.VAAYU_TEST_JWT_SECRET || parsed.JWT_SECRET || '';
const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000';
const databaseUrl = process.env.DATABASE_URL || parsed.DATABASE_URL || '';

function token(user) {
  return jwt.sign({ ...user, city: 'Hyderabad' }, secret, { algorithm: 'HS256', expiresIn: 900 });
}

async function request(method, url, auth, body) {
  const options = { method, headers: {} };
  if (auth) options.headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  return { status: res.status, data };
}

async function readTrip(pool, tripId) {
  const { rows } = await pool.query(
    "SELECT data FROM vaayu_records WHERE collection='trips' AND record_key=$1",
    [`id:${tripId}`]
  );
  assert.equal(rows.length, 1, `PostgreSQL must contain authoritative trip ${tripId}`);
  return rows[0].data;
}

async function readPayment(pool, paymentId) {
  const { rows } = await pool.query('SELECT * FROM payment_transactions WHERE payment_id=$1', [paymentId]);
  assert.equal(rows.length, 1, `PostgreSQL must contain payment ${paymentId}`);
  return rows[0];
}

test('Financial lifecycle reconciliation: wallet -> escrow -> delivered trip -> settlement -> ledger invariants', async (t) => {
  assert.ok(secret.length >= 32, 'JWT secret must be at least 32 chars');
  assert.ok(databaseUrl, 'DATABASE_URL is required');

  await runMigrations();
  const pool = new PostgresPool({ connectionString: databaseUrl });
  const repo = new PostgresLedgerRepository(pool);
  t.after(async () => { await pool.end(); });

  const suffix = Date.now();
  const customerId = `cust_fin_cert_${suffix}`;
  const adminToken = token({ id: `adm_fin_${suffix}`, name: 'Financial Certification Admin', phone: '9999966666', role: 'ADMIN' });
  const customerToken = token({ id: customerId, name: 'Financial Certification Customer', phone: `98888${String(suffix).slice(-5)}`, role: 'CUSTOMER' });

  const farePaise = 30000;
  const commissionPaise = 3000;

  // 1. Build a real eligible driver through the admin surface and establish canonical telemetry.
  const driverPhone = `90666${String(suffix).slice(-5)}`;
  const created = await request('POST', '/api/admin/drivers/create', adminToken, {
    name: 'Financial Certification Driver',
    phone: driverPhone,
    vehicleId: 'v_2w',
    vehicleNumber: `TS09FC${String(suffix).slice(-4)}`,
    city: 'Hyderabad'
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const driver = created.data.driver;
  assert.ok(driver?.id && driver?.userId);

  const kyc = await request('POST', '/api/admin/drivers/update-kyc', adminToken, {
    driverId: driver.id,
    kycStatus: 'APPROVED'
  });
  assert.equal(kyc.status, 200, JSON.stringify(kyc.data));

  const driverToken = token({ id: driver.userId, name: driver.name, phone: driver.phone, role: 'DRIVER' });
  assert.equal((await request('POST', '/api/driver/update', driverToken, {
    driver_id: driver.id, status: 'ONLINE', lat: 17.3850, lng: 78.4867
  })).status, 200);
  assert.equal((await request('POST', '/api/driver/location/update', driverToken, {
    driverId: driver.id, lat: 17.3850, lng: 78.4867, speed: 0, bearing: 0
  })).status, 200);

  // 2. Fund the customer wallet using the production ledger repository, then reserve escrow.
  const topup = await repo.topUpCustomerWallet({
    customerId,
    amountPaise: 50000,
    idempotencyKey: `FIN:${suffix}:TOPUP`,
    referenceId: `FIN:${suffix}:TOPUP`
  });
  assert.equal(topup.success, true);
  assert.equal(topup.customerBalance.paise, 50000);

  const booking = await request('POST', '/api/trips/create', customerToken, {
    pickupLat: 17.3850,
    pickupLng: 78.4867,
    dropLat: 17.4400,
    dropLng: 78.3489,
    pickupAddress: 'Abids, Hyderabad',
    dropAddress: 'Hitec City, Hyderabad',
    vehicleId: 'v_2w',
    paymentMethod: 'WALLET',
    idempotencyKey: `FIN:${suffix}:BOOK`
  });
  assert.equal(booking.status, 200, JSON.stringify(booking.data));
  assert.ok(booking.data.trip?.id);
  assert.equal(booking.data.dispatch?.assignedDriver?.driverId, driver.id);
  const tripId = booking.data.trip.id;

  const escrow = await repo.reserveEscrow({
    tripId,
    orderId: tripId,
    customerId,
    amountPaise: farePaise,
    idempotencyKey: `VAAYU:${tripId}:ESCROW`
  });
  assert.equal(escrow.status, 'ESCROWED');
  assert.equal(escrow.amountPaise, farePaise);
  assert.equal(escrow.customerBalance.paise, 20000);

  const paymentId = `PAY_${tripId}`;
  let payment = await readPayment(pool, paymentId);
  assert.equal(payment.state, 'ESCROWED');
  assert.equal(Number(payment.escrow_paise), farePaise);
  assert.equal(payment.driver_id, null);

  // 3. The lifecycle must now progress through the same authoritative trip state machine.
  const accept = await request('POST', `/api/orders/accept`, driverToken, {
    orderId: tripId,
    idempotencyKey: `FIN:${tripId}:ACCEPT`
  });
  assert.equal(accept.status, 200, JSON.stringify(accept.data));

  const arrive = await request('POST', `/api/orders/start-arriving`, driverToken, {
    orderId: tripId,
    idempotencyKey: `FIN:${tripId}:ARRIVE_START`
  });
  assert.equal(arrive.status, 200, JSON.stringify(arrive.data));

  assert.equal((await request('POST', '/api/driver/location/update', driverToken, {
    driverId: driver.id, lat: 17.3850, lng: 78.4867, speed: 0, bearing: 0
  })).status, 200);
  assert.equal((await request('POST', `/api/orders/arrived-pickup`, driverToken, {
    orderId: tripId, idempotencyKey: `FIN:${tripId}:PICKUP_ARRIVE`
  })).status, 200);

  let trip = await readTrip(pool, tripId);
  const pickupOtp = String(trip.pickupOtp);
  const deliveryOtp = String(trip.deliveryOtp);
  assert.equal(trip.status, 'DRIVER_AT_PICKUP');

  assert.equal((await request('POST', `/api/orders/confirm-pickup`, driverToken, {
    orderId: tripId, otp: pickupOtp, idempotencyKey: `FIN:${tripId}:PICKUP_CONFIRM`
  })).status, 200);
  assert.equal((await request('POST', `/api/orders/start-transit`, driverToken, {
    orderId: tripId, idempotencyKey: `FIN:${tripId}:TRANSIT`
  })).status, 200);

  assert.equal((await request('POST', '/api/driver/location/update', driverToken, {
    driverId: driver.id, lat: 17.4400, lng: 78.3489, speed: 0, bearing: 0
  })).status, 200);
  assert.equal((await request('POST', `/api/orders/arrived-dropoff`, driverToken, {
    orderId: tripId, idempotencyKey: `FIN:${tripId}:DROPOFF_ARRIVE`
  })).status, 200);

  const complete = await request('POST', `/api/orders/complete`, driverToken, {
    orderId: tripId,
    otp: deliveryOtp,
    proof: { receiverName: 'Financial Certification Receiver' },
    idempotencyKey: `FIN:${tripId}:COMPLETE`
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.data));

  trip = await readTrip(pool, tripId);
  assert.equal(trip.status, 'DELIVERED');
  assert.ok(trip.completedAt);

  // 4. Settle exactly once from the authoritative escrow and reconcile every financial projection.
  const settlement = await repo.settleTrip({
    tripId,
    driverId: driver.id,
    platformCommissionPaise: commissionPaise,
    idempotencyKey: `VAAYU:${tripId}:SETTLE`
  });
  assert.equal(settlement.status, 'SETTLED');
  assert.equal(settlement.totalFarePaise, farePaise);
  assert.equal(settlement.commissionPaise, commissionPaise);
  assert.equal(settlement.gstPaise, 540);
  assert.equal(settlement.driverEarningsPaise, 26460);

  payment = await readPayment(pool, paymentId);
  assert.equal(payment.state, 'SETTLED');
  assert.equal(Number(payment.escrow_paise), 0);
  assert.equal(Number(payment.driver_earnings_paise), 26460);
  assert.equal(Number(payment.commission_paise), 3000);
  assert.equal(Number(payment.gst_paise), 540);
  assert.equal(payment.driver_id, driver.id);

  const customerBalance = await repo.getCustomerBalance(customerId);
  const driverBalance = await repo.getDriverBalance(driver.id);
  assert.equal(customerBalance.paise, 20000);
  assert.equal(driverBalance.paise, 26460);

  // 5. A second settlement must be rejected, not silently create another journal entry.
  await assert.rejects(
    () => repo.settleTrip({
      tripId,
      driverId: driver.id,
      platformCommissionPaise: commissionPaise,
      idempotencyKey: `FIN:${tripId}:DOUBLE_SETTLE`
    }),
    (err) => {
      assert.equal(err.code, 'ILLEGAL_PAYMENT_TRANSITION');
      return true;
    }
  );

  // 6. Re-run authoritative accounting reconciliation and inspect the outbox.
  const reconciliation = await repo.reconcile();
  assert.equal(reconciliation.ok, true, `Ledger reconciliation failed: ${reconciliation.problems.join(', ')}`);
  assert.deepEqual(reconciliation.problems, []);

  const audit = await repo.getLedgerAudit();
  assert.equal(audit.invariants.debitsEqualCredits, true);
  assert.equal(audit.invariants.accountingEquationSatisfied, true);
  assert.equal(audit.statutoryGst.ratioCompliant, true);

  const outbox = await pool.query(
    "SELECT event_type, status, payload FROM payment_outbox WHERE aggregate_id=$1 ORDER BY created_at ASC",
    [paymentId]
  );
  const eventTypes = outbox.rows.map(row => row.event_type);
  assert.ok(eventTypes.includes('PaymentEscrowed'));
  assert.ok(eventTypes.includes('PaymentSettled'));
  assert.ok(outbox.rows.every(row => row.status === 'PENDING' || row.status === 'PROCESSED'), 'Outbox events must remain in a valid state');

  // 7. Final cross-layer assertions: API tracking, trip state, payment state, and ledger state converge.
  const tracking = await request('GET', `/api/public/tracking/${encodeURIComponent(trip.trackingToken)}`);
  assert.equal(tracking.status, 200);
  assert.equal(tracking.data.trip.status, 'DELIVERED');
  assert.equal(Object.hasOwn(tracking.data.trip, 'deliveryOtp'), false);

  const adminActive = await request('GET', '/api/admin/trips/active', adminToken);
  assert.equal(adminActive.status, 200);
  assert.equal((adminActive.data.activeTrips || []).some(item => item.id === tripId), false, 'Delivered trip must leave active-trip projection');

  const dbTrip = await readTrip(pool, tripId);
  assert.equal(dbTrip.status, 'DELIVERED');
  assert.equal(dbTrip.driver?.id, driver.id);
  assert.equal(dbTrip.proofOfDelivery?.receiverName, 'Financial Certification Receiver');
});
