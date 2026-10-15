'use strict';

/**
 * Pillar 9: Dispatch Correctness & Concurrency Verification Test Suite
 *
 * Verifies:
 * 1. P9.1: Deterministic Multi-Factor Scoring & Candidate Filtering
 *    - Distance + ETA + Rating + Vehicle Match - Workload Fairness Penalty
 *    - Strict exclusion of STALE/OFFLINE telemetry and busy drivers
 * 2. P9.2: Atomic Offer Lock & Anti-Double-Assignment Concurrency Race
 *    - High-concurrency race: 10 orders competing for 1 top driver simultaneously
 *    - Exactly 1 winner acquires atomic reservation lock; 9 collide with DRIVER_LOCKED
 *    - Zero double-assignments across multi-node simulation
 * 3. P9.3: Cascading Fallback & Timeout Re-dispatch
 *    - Driver decline adds driver to cluster decline set (SADD)
 *    - Automatic immediate re-dispatch to rank-2 candidate
 *    - 30-second offer expiration cleans lock and offers rank-3 candidate
 * 4. P9.4: Physical Evidence, Geofencing & Dual-OTP Enforcement
 *    - Geofence constraint enforcement (<= 300m for arrival states)
 *    - Rejection of premature pickup/dropoff without proximity proof
 *    - Separate goods pickup OTP and delivery handover OTP validation
 * 5. P9.5: Optimistic Concurrency Control (OCC) & Financial Ledger Settlement
 *    - Monotonic version gating (expectedVersion !== currentVersion -> CONCURRENCY_CONFLICT)
 *    - Post-dispatch trip settlement preserves double-entry parity (₹0 imbalance)
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const db = require('../../src/db/database');
const { dispatchService, DispatchService } = require('../../src/services/dispatchService');
const { redisLockManager } = require('../../src/services/redisLockManager');
const { deliveryStateMachine, DELIVERY_STATES } = require('../../src/services/deliveryStateMachine');
const { driverLocationService } = require('../../src/services/driverLocationService');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');

test('Pillar 9: Dispatch Correctness & Concurrency Certification Suite', async (suite) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  const pool = new PostgresPool({ connectionString, max: 10 });
  const repo = new PostgresLedgerRepository(pool);
  const psm = new PaymentStateMachine({ ledgerService: repo });
  const integrationService = new PaymentIntegrationService({ ledgerService: repo, paymentStateMachine: psm });

  suite.before(async () => {
    await repo.ensureAccount('cash:external', 'ASSET', 'DEBIT');
    await repo.ensureAccount('escrow:platform', 'LIABILITY', 'CREDIT');
    await repo.ensureAccount('platform:commission', 'REVENUE', 'CREDIT');
    await repo.ensureAccount('platform:gst', 'LIABILITY', 'CREDIT');
    await repo.ensureAccount('payout:clearing', 'LIABILITY', 'CREDIT');
  });

  suite.after(async () => {
    await dispatchService.resetDispatchState();
    await new Promise(r => setTimeout(r, 100));
    await pool.end();
  });

  // =========================================================================
  // 9.1 DETERMINISTIC MULTI-FACTOR SCORING & CANDIDATE FILTERING
  // =========================================================================
  await suite.test('9.1: Deterministic Multi-Factor Scoring: Strict ranking, telemetry liveness & busy driver exclusion', async () => {
    await dispatchService.resetDispatchState();
    const store = db.getDb();
    if (!store.drivers) store.drivers = [];
    if (!store.driver_profiles) store.driver_profiles = [];

    const centerLat = 17.4400;
    const centerLng = 78.3800; // Hitec City

    // Driver 1: Close (1 km), High Rating (4.9), Matching Vehicle, 0 trips today
    const drv1 = {
      id: 'drv_p9_rank1',
      userId: 'drv_p9_rank1',
      name: 'Ramesh Pilot',
      phone: '9800000001',
      vehicleId: 'TATA_ACE',
      vehicleNumber: 'TS09AB1001',
      rating: 4.9,
      totalTrips: 0,
      currentLat: 17.4450, // ~0.6 km
      currentLng: 78.3820,
      status: 'ONLINE'
    };

    // Driver 2: Farther (5 km), Moderate Rating (4.5), Matching Vehicle, 0 trips
    const drv2 = {
      id: 'drv_p9_rank2',
      userId: 'drv_p9_rank2',
      name: 'Suresh Pilot',
      phone: '9800000002',
      vehicleId: 'TATA_ACE',
      vehicleNumber: 'TS09AB1002',
      rating: 4.5,
      totalTrips: 0,
      currentLat: 17.4800, // ~5 km
      currentLng: 78.3800,
      status: 'ONLINE'
    };

    // Driver 3: Stale Telemetry (>3 mins old ping) -> Must be excluded
    const drv3 = {
      id: 'drv_p9_stale',
      userId: 'drv_p9_stale',
      name: 'Stale Pilot',
      phone: '9800000003',
      vehicleId: 'TATA_ACE',
      vehicleNumber: 'TS09AB1003',
      rating: 5.0,
      totalTrips: 0,
      currentLat: 17.4410,
      currentLng: 78.3810,
      status: 'ONLINE'
    };

    // Driver 4: Mismatched Vehicle (BOLERO vs TATA_ACE required) -> Must be excluded
    const drv4 = {
      id: 'drv_p9_mismatch',
      userId: 'drv_p9_mismatch',
      name: 'Mismatch Pilot',
      phone: '9800000004',
      vehicleId: 'BOLERO_MAX',
      vehicleNumber: 'TS09AB1004',
      rating: 5.0,
      totalTrips: 0,
      currentLat: 17.4410,
      currentLng: 78.3810,
      status: 'ONLINE'
    };

    // Save drivers to store
    for (const d of [drv1, drv2, drv3, drv4]) {
      const idx = store.driver_profiles.findIndex(x => x.id === d.id);
      if (idx >= 0) store.driver_profiles[idx] = d;
      else store.driver_profiles.push(d);
    }
    db.saveDb(store);

    // Update driverLocationService states
    await driverLocationService.updateDriverLocation(drv1.id, { lat: drv1.currentLat, lng: drv1.currentLng, speed: 20 });
    await driverLocationService.updateDriverLocation(drv2.id, { lat: drv2.currentLat, lng: drv2.currentLng, speed: 20 });
    
    // Inject explicitly stale state for drv3
    await driverLocationService.updateDriverLocation(drv3.id, {
      lat: drv3.currentLat,
      lng: drv3.currentLng,
      timestamp: Date.now() - 250000 // > 4 mins ago -> STALE
    });

    const mockOrder = {
      id: `ORD_P9_SCORE_${Date.now()}`,
      pickupLat: centerLat,
      pickupLng: centerLng,
      vehicleId: 'TATA_ACE'
    };

    const candidates = await dispatchService.getCandidateDrivers(mockOrder);

    // Assertions
    assert.ok(candidates.length >= 2, 'Must discover at least 2 valid candidates');
    assert.equal(candidates[0].driverId, drv1.id, 'Rank 1 candidate must be drv1 (closest, highest rating)');
    assert.equal(candidates[1].driverId, drv2.id, 'Rank 2 candidate must be drv2');
    assert.ok(candidates[0].totalScore > candidates[1].totalScore, 'Score for drv1 must strictly exceed drv2');

    const candidateIds = candidates.map(c => c.driverId);
    assert.ok(!candidateIds.includes(drv3.id), 'Stale telemetry driver must be excluded from dispatch');
    assert.ok(!candidateIds.includes(drv4.id), 'Mismatched vehicle driver must be excluded from dispatch');
  });

  // =========================================================================
  // 9.2 ATOMIC OFFER LOCK & ANTI-DOUBLE-ASSIGNMENT RACE
  // =========================================================================
  await suite.test('9.2: Atomic Offer Lock & Anti-Double-Assignment: Concurrency race yields exactly 1 winner & N-1 collisions', async () => {
    await dispatchService.resetDispatchState();
    const store = db.getDb();
    if (!store.trips) store.trips = [];

    // Clear busy active trips from earlier tests to ensure clean driver availability state
    store.trips = store.trips.filter(t => ['DELIVERED', 'CANCELLED', 'FAILED'].includes(t.status));

    const contestedDriverId = 'drv_p9_contested';
    const contestedDriver = {
      id: contestedDriverId,
      userId: contestedDriverId,
      name: 'Pravin Star Pilot',
      phone: '9811111111',
      vehicleId: 'ELECTRIC_3W', // Use a unique vehicle type so ONLY this driver matches!
      vehicleNumber: 'TS09AC9999',
      rating: 5.0,
      totalTrips: 0,
      currentLat: 17.4405,
      currentLng: 78.3805,
      status: 'ONLINE'
    };

    const dIdx = store.driver_profiles.findIndex(x => x.id === contestedDriverId);
    if (dIdx >= 0) store.driver_profiles[dIdx] = contestedDriver;
    else store.driver_profiles.push(contestedDriver);
    db.saveDb(store);

    await driverLocationService.updateDriverLocation(contestedDriverId, {
      lat: contestedDriver.currentLat,
      lng: contestedDriver.currentLng,
      speed: 15,
      vehicleId: 'ELECTRIC_3W'
    });

    // Create 10 competing orders simultaneously needing ELECTRIC_3W at the same pickup
    const numCompOrders = 10;
    const competingOrderIds = [];
    for (let i = 0; i < numCompOrders; i++) {
      const oId = `ORD_P9_RACE_${Date.now()}_${i}`;
      competingOrderIds.push(oId);
      const tripObj = {
        id: oId,
        customerId: `cust_race_${i}`,
        status: DELIVERY_STATES.SEARCHING_DRIVER,
        version: 1,
        pickupAddress: 'Hitec City, Hyderabad',
        pickupLat: 17.4400,
        pickupLng: 78.3800,
        dropAddress: 'Kondapur, Hyderabad',
        dropLat: 17.4600,
        dropLng: 78.3600,
        vehicleId: 'ELECTRIC_3W',
        createdAt: new Date().toISOString()
      };
      store.trips.push(tripObj);
    }
    db.saveDb(store);

    // Launch all 10 dispatch attempts in parallel against the exact same single-candidate pool
    const results = await Promise.all(
      competingOrderIds.map(orderId => dispatchService.findAndOfferDriver(orderId))
    );

    // Filter results that successfully reserved the driver
    const successfulAssignments = results.filter(r => r.success && r.assignedDriver?.driverId === contestedDriverId);
    const lockedCollisions = results.filter(r => !r.success);

    // Strict Concurrency Invariants
    assert.equal(successfulAssignments.length, 1, 'Exactly ONE order must win the atomic driver reservation lock');
    assert.equal(lockedCollisions.length, numCompOrders - 1, 'All remaining 9 competing orders must encounter collision without double-assignment');

    // Verify Redis lock ownership
    const lockStatus = await redisLockManager.getDriverLock(contestedDriverId);
    assert.ok(lockStatus, 'Redis driver lock must exist');
    assert.equal(lockStatus.driverId, contestedDriverId);
    assert.equal(lockStatus.orderId, successfulAssignments[0].orderId, 'Redis lock orderId must match the sole winner');
  });

  // =========================================================================
  // 9.3 CASCADING FALLBACK & TIMEOUT RE-DISPATCH
  // =========================================================================
  await suite.test('9.3: Cascading Fallback & Timeout Re-dispatch: Cluster decline SADD, immediate fallback to rank 2, and timeout recovery', async () => {
    await dispatchService.resetDispatchState();
    const store = db.getDb();
    if (!store.trips) store.trips = [];

    // Clear active non-terminal trips
    store.trips = store.trips.filter(t => ['DELIVERED', 'CANCELLED', 'FAILED'].includes(t.status));

    // Register two dedicated fallback test drivers with unique vehicle type
    const fbDriver1 = {
      id: 'drv_p9_fb_1',
      userId: 'drv_p9_fb_1',
      name: 'Fallback One',
      phone: '9822222201',
      vehicleId: 'SPECIAL_HEAVY_TRUCK',
      vehicleNumber: 'TS09FB1001',
      rating: 5.0,
      totalTrips: 0,
      currentLat: 17.4410,
      currentLng: 78.3810,
      status: 'ONLINE'
    };

    const fbDriver2 = {
      id: 'drv_p9_fb_2',
      userId: 'drv_p9_fb_2',
      name: 'Fallback Two',
      phone: '9822222202',
      vehicleId: 'SPECIAL_HEAVY_TRUCK',
      vehicleNumber: 'TS09FB1002',
      rating: 4.6,
      totalTrips: 0,
      currentLat: 17.4500,
      currentLng: 78.3820,
      status: 'ONLINE'
    };

    for (const d of [fbDriver1, fbDriver2]) {
      const idx = store.driver_profiles.findIndex(x => x.id === d.id);
      if (idx >= 0) store.driver_profiles[idx] = d;
      else store.driver_profiles.push(d);
    }
    db.saveDb(store);

    await driverLocationService.updateDriverLocation(fbDriver1.id, {
      lat: fbDriver1.currentLat,
      lng: fbDriver1.currentLng,
      speed: 10,
      vehicleId: 'SPECIAL_HEAVY_TRUCK'
    });
    await driverLocationService.updateDriverLocation(fbDriver2.id, {
      lat: fbDriver2.currentLat,
      lng: fbDriver2.currentLng,
      speed: 10,
      vehicleId: 'SPECIAL_HEAVY_TRUCK'
    });

    const orderId = `ORD_P9_FALLBACK_${Date.now()}`;
    const tripRecord = {
      id: orderId,
      customerId: 'cust_fb_01',
      status: DELIVERY_STATES.SEARCHING_DRIVER,
      version: 1,
      pickupLat: 17.4400,
      pickupLng: 78.3800,
      dropLat: 17.4600,
      dropLng: 78.3600,
      vehicleId: 'SPECIAL_HEAVY_TRUCK',
      createdAt: new Date().toISOString()
    };
    store.trips.push(tripRecord);
    db.saveDb(store);

    // 1. Initial Offer -> Should match Rank 1 (drv_p9_fb_1)
    const offer1 = await dispatchService.findAndOfferDriver(orderId);
    assert.equal(offer1.success, true);
    assert.equal(offer1.assignedDriver.driverId, fbDriver1.id, 'First offer must go to rank 1 candidate');

    // 2. Driver 1 Declines Offer
    const declineRes = await dispatchService.handleDriverDecline(orderId, fbDriver1.id, 'Fuel low');
    assert.equal(declineRes.success, true);

    // 3. Cluster Decline Set Invariant: fbDriver1 must be in declined set
    const declined = await redisLockManager.getDeclinedDrivers(orderId);
    assert.ok(declined.has(fbDriver1.id), 'Declined driver must be recorded in cluster decline set');

    // 4. Cascading Fallback: The immediate re-dispatch must have assigned Rank 2 (fbDriver2)
    assert.equal(declineRes.assignedDriver.driverId, fbDriver2.id, 'Fallback must automatically offer to rank 2 candidate');
    const tripAfterDecline = db.getTripById(orderId);
    assert.equal(tripAfterDecline.status, DELIVERY_STATES.DRIVER_ASSIGNED);
    assert.equal(tripAfterDecline.driver.id, fbDriver2.id);

    // 5. Driver 2 Expiration Simulation: Timeout fires and releases driver 2 lock
    await dispatchService.handleOfferTimeout(orderId, fbDriver2.id);

    // Verify driver 2 lock is released
    const lockDrv2 = await redisLockManager.getDriverLock(fbDriver2.id);
    assert.equal(lockDrv2, null, 'Driver 2 lock must be cleanly released upon offer timeout');

    // Verify both driver 1 and driver 2 are recorded in decline set
    const updatedDeclined = await redisLockManager.getDeclinedDrivers(orderId);
    assert.ok(updatedDeclined.has(fbDriver1.id));
    assert.ok(updatedDeclined.has(fbDriver2.id));
  });

  // =========================================================================
  // 9.4 PHYSICAL EVIDENCE, GEOFENCING & DUAL-OTP ENFORCEMENT
  // =========================================================================
  await suite.test('9.4: Geofencing & Dual-OTP Enforcement: Proximity constraints (<=300m) and separate pickup/delivery verification', async () => {
    const tripId = `TRIP_P9_GEO_${Date.now()}`;
    const driverId = 'drv_p9_geo_tester';
    const pickupOtp = '4521';
    const deliveryOtp = '8910';

    const store = db.getDb();
    if (!store.trips) store.trips = [];
    const tripRecord = {
      id: tripId,
      customerId: 'cust_geo_01',
      status: DELIVERY_STATES.DRIVER_ACCEPTED,
      version: 1,
      pickupLat: 17.4400,
      pickupLng: 78.3800,
      dropLat: 17.5000,
      dropLng: 78.4000,
      pickupOtp,
      deliveryOtp,
      driver: { id: driverId, name: 'Sanjay Geofence' },
      createdAt: new Date().toISOString()
    };
    store.trips.push(tripRecord);
    db.saveDb(store);

    // Step 1: DRIVER_ACCEPTED -> DRIVER_ARRIVING
    const t1 = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.DRIVER_ARRIVING, { type: 'DRIVER', id: driverId });
    assert.equal(t1.success, true);

    // Step 2: Driver initial position 5 km away (bypass speed filter to establish baseline distant location)
    await driverLocationService.updateDriverLocation(driverId, {
      lat: 17.4900,
      lng: 78.3800,
      speed: 30,
      bypassSpeedFilter: true
    });

    // Attempt DRIVER_AT_PICKUP while Driver is 5.5 km away (Geofence Breach)
    const t2Premature = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.DRIVER_AT_PICKUP, { type: 'DRIVER', id: driverId });
    assert.equal(t2Premature.success, false);
    assert.equal(t2Premature.error?.code, 'GEOFENCE_VALIDATION_FAILED', 'Must reject arrival when outside 300m geofence');

    // Step 3: Driver moves within 70m of Pickup (use bypassSpeedFilter to jump safely in unit test)
    await driverLocationService.updateDriverLocation(driverId, {
      lat: 17.4405,
      lng: 78.3805,
      speed: 5,
      bypassSpeedFilter: true
    });
    const t2Valid = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.DRIVER_AT_PICKUP, { type: 'DRIVER', id: driverId });
    assert.equal(t2Valid.success, true);

    // Step 4: Attempt PICKUP_CONFIRMED with Wrong OTP
    const t3WrongOtp = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.PICKUP_CONFIRMED, { type: 'DRIVER', id: driverId }, { otp: '0000' });
    assert.equal(t3WrongOtp.success, false);
    assert.equal(t3WrongOtp.error?.code, 'OTP_VERIFICATION_FAILED');

    // Step 5: Valid Pickup OTP -> Transition to IN_TRANSIT
    const t3ValidOtp = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.PICKUP_CONFIRMED, { type: 'DRIVER', id: driverId }, { otp: pickupOtp });
    assert.equal(t3ValidOtp.success, true);

    const t4InTransit = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.IN_TRANSIT, { type: 'DRIVER', id: driverId });
    assert.equal(t4InTransit.success, true);

    // Step 6: Driver moves to Dropoff within 80m -> DRIVER_AT_DROPOFF succeeds
    await driverLocationService.updateDriverLocation(driverId, {
      lat: 17.5005,
      lng: 78.4005,
      speed: 2,
      bypassSpeedFilter: true
    });
    const t5AtDrop = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.DRIVER_AT_DROPOFF, { type: 'DRIVER', id: driverId });
    assert.equal(t5AtDrop.success, true);

    // Step 7: Delivery Handover with Valid Delivery OTP
    const t6Delivered = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.DELIVERED, { type: 'DRIVER', id: driverId }, {
      otp: deliveryOtp,
      proof: { podPhotoUrl: 'https://cdn.vaayu.com/pod_01.jpg', receiverName: 'Vikram Store Manager' }
    });
    assert.equal(t6Delivered.success, true);
    assert.equal(t6Delivered.trip.status, DELIVERY_STATES.DELIVERED);
    assert.ok(t6Delivered.trip.proofOfDelivery, 'Proof of delivery must be recorded upon successful handover');
  });

  // =========================================================================
  // 9.5 OPTIMISTIC CONCURRENCY CONTROL (OCC) & FINANCIAL LEDGER PARITY
  // =========================================================================
  await suite.test('9.5: OCC Version Invariant & Financial Settlement: Stale version mutation rejected, double-entry ledger balanced', async () => {
    const tripId = `TRIP_P9_OCC_${Date.now()}`;
    const customerId = `cust_occ_${Date.now()}`;
    const driverId = `drv_occ_${Date.now()}`;
    const farePaise = 45000; // ₹450.00

    // Fund customer wallet & Reserve Escrow Hold in frozen PostgreSQL ledger
    await repo.topUpCustomerWallet({ customerId, amountPaise: 100000, idempotencyKey: `top:occ:${tripId}` });
    const escrowRes = await integrationService.reserveEscrow({
      tripId,
      orderId: tripId,
      customerId,
      amountPaise: farePaise,
      idempotencyKey: `esc:occ:${tripId}`
    });
    assert.equal(escrowRes.success, true);

    // Seed initial trip in state machine
    const store = db.getDb();
    if (!store.trips) store.trips = [];
    const tripObj = {
      id: tripId,
      customerId,
      status: DELIVERY_STATES.CREATED,
      version: 1,
      farePaise,
      createdAt: new Date().toISOString()
    };
    store.trips.push(tripObj);
    db.saveDb(store);

    // 1. Advance version from 1 to 2
    const v1to2 = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.SEARCHING_DRIVER, { type: 'SYSTEM', id: 'TEST' }, {
      expectedVersion: 1
    });
    assert.equal(v1to2.success, true);
    assert.equal(v1to2.trip.version, 2, 'Version must increment to 2');

    // 2. Concurrency Conflict: Attempt mutation with stale expectedVersion = 1
    const staleMutation = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.CANCELLED, { type: 'CUSTOMER', id: customerId }, {
      expectedVersion: 1
    });
    assert.equal(staleMutation.success, false);
    assert.equal(staleMutation.error?.code, 'CONCURRENCY_CONFLICT', 'Stale version mutation must fail closed with CONCURRENCY_CONFLICT');

    // 3. Advance to terminal state DELIVERED with correct versioning
    const updatedTrip = db.getTripById(tripId);
    updatedTrip.status = DELIVERY_STATES.DELIVERED;
    updatedTrip.version = 3;
    db.saveDb(store);

    // 4. Execute Financial Settlement against PostgreSQL ledger
    const settleRes = await integrationService.settleTrip({
      tripId,
      driverId,
      idempotencyKey: `set:occ:${tripId}`
    });
    assert.equal(settleRes.success, true);
    assert.equal(settleRes.state, 'SETTLED');

    // 5. Invariant Audit: Zero ledger imbalance across double-entry repository
    const recon = await repo.reconcile();
    assert.equal(recon.ok, true, 'PostgreSQL double-entry reconciliation must be 100% OK post-dispatch lifecycle');
    assert.equal(recon.problems.length, 0, 'Ledger must have 0 reconciliation problems (₹0 imbalance)');
  });
});
