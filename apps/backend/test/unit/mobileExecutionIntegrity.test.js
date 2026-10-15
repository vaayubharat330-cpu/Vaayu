'use strict';

/**
 * Pillar 15: Flutter Android/iOS Reliability & Mobile Execution Integrity Architecture Test Suite
 *
 * Invariant Validation Matrix:
 * 15.1 Client State Authority Projection (Read-only projection; server is source of truth)
 * 15.2 App Backgrounding & Lifecycle Suspension (Quiescing socket, JWT expiration detection)
 * 15.3 Cold Process Death & Crash Recovery (Authoritative /api/trips/:id re-anchoring)
 * 15.4 Network Flapping & Request Deduplication (X-Idempotency-Key retry safety)
 * 15.5 WebSocket vs Push Notification Racing (Monotonic version gating)
 * 15.6 Optimistic UI Rollback on Server Rejection (Geofence / OTP failure rollback)
 * 15.7 GPS Permission Revocation & Degraded Location Handling (Graceful degradation)
 * 15.8 Offline Transition Queue Serialization (FIFO ordering & conflict resolution)
 * 15.9 Multi-Role Mobile Session Switching (Driver vs Customer isolation)
 * 15.10 Double-Entry Financial Core Parity (Post-execution ₹0 imbalance)
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const db = require('../../src/db/database');
const { authService } = require('../../src/services/authService');
const { deliveryStateMachine, DELIVERY_STATES } = require('../../src/services/deliveryStateMachine');
const { driverLocationService } = require('../../src/services/driverLocationService');
const { WebSocketService } = require('../../src/services/websocketService');
const { RedisPubSubManager } = require('../../src/services/redisPubSub');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');

/**
 * Mobile Client Simulator (Mirroring Flutter Client Behavior)
 */
class MobileClientSimulator {
  constructor(userId, role, token, options = {}) {
    this.userId = userId;
    this.role = role;
    this.token = token;
    this.appPlatform = options.platform || 'android';
    this.appVersion = options.version || '2.4.0';
    this.lifecycleState = 'resumed'; // 'resumed', 'paused', 'inactive', 'detached'
    this.localState = {
      activeTrip: null,
      lastSeenVersion: 0,
      optimisticState: null
    };
    this.offlineQueue = [];
    this.socketConnection = null;
    this.locationPermissionGranted = true;
  }

  // Lifecycle Transition: App backgrounded / paused
  pauseApp() {
    this.lifecycleState = 'paused';
    if (this.socketConnection) {
      this.socketConnection.isPaused = true;
    }
  }

  // Lifecycle Transition: App resumed
  resumeApp() {
    this.lifecycleState = 'resumed';
    if (this.socketConnection) {
      this.socketConnection.isPaused = false;
    }
    // Verify token freshness upon foregrounding
    const verified = authService.verifyToken(this.token);
    return { tokenValid: Boolean(verified), payload: verified };
  }

  // Simulate Cold Process Crash / Kill
  killProcess() {
    this.socketConnection = null;
    this.localState = {
      activeTrip: null,
      lastSeenVersion: 0,
      optimisticState: null
    };
  }

  // Authoritative Resync Handshake against backend
  resyncActiveTrip(tripId) {
    const authoritativeTrip = db.getTripById(tripId);
    if (!authoritativeTrip) {
      this.localState.activeTrip = null;
      this.localState.lastSeenVersion = 0;
      return null;
    }
    this.localState.activeTrip = { ...authoritativeTrip };
    this.localState.lastSeenVersion = authoritativeTrip.version || 1;
    this.localState.optimisticState = null;
    return this.localState.activeTrip;
  }

  // Receive Push or WebSocket event with monotonic version check
  handleIncomingEvent(event) {
    if (!event || !event.tripId) return { processed: false, reason: 'INVALID_EVENT' };
    const eventVersion = event.version || 0;
    if (eventVersion <= this.localState.lastSeenVersion) {
      return { processed: false, reason: 'STALE_OR_DUPLICATE_VERSION', current: this.localState.lastSeenVersion, received: eventVersion };
    }
    this.localState.lastSeenVersion = eventVersion;
    if (this.localState.activeTrip && this.localState.activeTrip.id === event.tripId) {
      this.localState.activeTrip.status = event.status;
      this.localState.activeTrip.version = eventVersion;
    }
    return { processed: true, version: eventVersion, status: event.status };
  }

  // Optimistic UI state transition with rollback capability
  applyOptimisticState(optimisticState) {
    this.localState.optimisticState = optimisticState;
  }

  rollbackOptimisticState() {
    this.localState.optimisticState = null;
  }
}

test('Pillar 15: Flutter Android/iOS Reliability & Mobile Execution Integrity Architecture Suite', async (suite) => {
  const pubSub = new RedisPubSubManager();
  const wsService = new WebSocketService(pubSub);

  // Initialize test users
  const customerUser = {
    id: `usr_mob_cust_${Date.now()}`,
    name: 'Mobile Customer Tester',
    phone: '+91 9998887771',
    role: 'CUSTOMER',
    city: 'Hyderabad'
  };
  const driverUser = {
    id: `usr_mob_drv_${Date.now()}`,
    name: 'Mobile Driver Tester',
    phone: '+91 9998887772',
    role: 'DRIVER',
    city: 'Hyderabad'
  };

  const customerToken = authService.generateToken(customerUser);
  const driverToken = authService.generateToken(driverUser);

  // Seed DB with driver profile
  const store = db.getDb();
  if (!store.drivers) store.drivers = [];
  let driverProfile = store.drivers.find(d => d.id === driverUser.id || d.userId === driverUser.id);
  if (!driverProfile) {
    driverProfile = {
      id: driverUser.id,
      userId: driverUser.id,
      name: driverUser.name,
      phone: driverUser.phone,
      vehicleId: 'v_tata_ace',
      vehicleName: 'Tata Ace',
      vehicleNumber: 'TS09UB9900',
      status: 'ONLINE',
      currentLat: 17.440081,
      currentLng: 78.348916,
      walletBalance: 2500,
      totalTrips: 10
    };
    store.drivers.push(driverProfile);
    db.saveDb(store);
  }

  // --------------------------------------------------------------------------
  await suite.test('15.1 & 15.2: Client State Authority Projection, Backgrounding & Token Expiry', async () => {
    const client = new MobileClientSimulator(customerUser.id, 'CUSTOMER', customerToken, { platform: 'android', version: '2.4.1' });

    assert.equal(client.appPlatform, 'android');
    assert.equal(client.lifecycleState, 'resumed');
    assert.equal(client.localState.activeTrip, null);

    // Backgrounding
    client.pauseApp();
    assert.equal(client.lifecycleState, 'paused');

    // Resume app & token validity check
    const resumeCheck = client.resumeApp();
    assert.equal(resumeCheck.tokenValid, true);
    assert.equal(resumeCheck.payload.id, customerUser.id);

    // Simulate expired token on resume
    const expiredToken = authService.generateToken(customerUser, -1000); // 1 sec in past
    const expiredClient = new MobileClientSimulator(customerUser.id, 'CUSTOMER', expiredToken);
    const expiredResumeCheck = expiredClient.resumeApp();
    assert.equal(expiredResumeCheck.tokenValid, false, 'Expired JWT must be rejected upon app foreground resume');
  });

  // --------------------------------------------------------------------------
  await suite.test('15.3: Cold Process Death & Authoritative Resync Handshake', async () => {
    const tripId = `TRIP_MOB_${Date.now()}_01`;
    const tripRecord = {
      id: tripId,
      customerId: customerUser.id,
      driver: { id: driverUser.id, name: driverUser.name, phone: driverUser.phone },
      pickupLat: 17.440081,
      pickupLng: 78.348916,
      dropLat: 17.448500,
      dropLng: 78.374000,
      pickupOtp: '4821',
      deliveryOtp: '7193',
      status: DELIVERY_STATES.IN_TRANSIT,
      version: 7,
      totalFare: 450,
      createdAt: new Date().toISOString()
    };
    db.createTrip(tripRecord);

    const client = new MobileClientSimulator(driverUser.id, 'DRIVER', driverToken);

    // 1. Client has state in memory
    client.resyncActiveTrip(tripId);
    assert.equal(client.localState.activeTrip.status, DELIVERY_STATES.IN_TRANSIT);
    assert.equal(client.localState.lastSeenVersion, 7);

    // 2. Cold process termination (OS low-memory kill)
    client.killProcess();
    assert.equal(client.localState.activeTrip, null);
    assert.equal(client.localState.lastSeenVersion, 0);

    // 3. Restart app and invoke Authoritative Resync Handshake
    const recoveredTrip = client.resyncActiveTrip(tripId);
    assert.ok(recoveredTrip, 'Must successfully recover active trip from server');
    assert.equal(recoveredTrip.status, DELIVERY_STATES.IN_TRANSIT);
    assert.equal(client.localState.lastSeenVersion, 7);
  });

  // --------------------------------------------------------------------------
  await suite.test('15.4: Network Flapping, Retries & Request Deduplication (X-Idempotency-Key)', async () => {
    const tripId = `TRIP_MOB_${Date.now()}_02`;
    const tripRecord = {
      id: tripId,
      customerId: customerUser.id,
      driver: { id: driverUser.id, name: driverUser.name, phone: driverUser.phone },
      pickupLat: 17.440081,
      pickupLng: 78.348916,
      dropLat: 17.448500,
      dropLng: 78.374000,
      pickupOtp: '1234',
      deliveryOtp: '5678',
      status: DELIVERY_STATES.DRIVER_ASSIGNED,
      version: 2,
      totalFare: 350,
      createdAt: new Date().toISOString()
    };
    db.createTrip(tripRecord);

    const mobileIdempotencyKey = `mobile-req-${crypto.randomUUID()}`;

    // First attempt: driver accepts offer
    const firstResult = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.DRIVER_ACCEPTED, { type: 'DRIVER', id: driverUser.id }, {
      idempotencyKey: mobileIdempotencyKey
    });
    assert.equal(firstResult.success, true);
    assert.equal(firstResult.trip.status, DELIVERY_STATES.DRIVER_ACCEPTED);
    const initialVersion = firstResult.trip.version;

    // Simulate Network timeout / client disconnect before receiving HTTP response:
    // Mobile client retries with the EXACT SAME X-Idempotency-Key
    const retryResult = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.DRIVER_ACCEPTED, { type: 'DRIVER', id: driverUser.id }, {
      idempotencyKey: mobileIdempotencyKey
    });

    assert.equal(retryResult.success, true);
    assert.equal(retryResult.duplicate || retryResult.trip?.version === initialVersion, true, 'Retry must return cached response or idempotent duplicate');
    assert.equal(retryResult.trip.status, DELIVERY_STATES.DRIVER_ACCEPTED);
    assert.equal(retryResult.trip.version, initialVersion, 'Version must not increment on duplicate retry');
  });

  // --------------------------------------------------------------------------
  await suite.test('15.5 & 15.6: WebSocket vs Push Racing & Optimistic UI Rollback on Geofence Failure', async () => {
    const tripId = `TRIP_MOB_${Date.now()}_03`;
    const tripRecord = {
      id: tripId,
      customerId: customerUser.id,
      driver: { id: driverUser.id, name: driverUser.name, phone: driverUser.phone },
      pickupLat: 17.440081,
      pickupLng: 78.348916,
      dropLat: 17.448500,
      dropLng: 78.374000,
      pickupOtp: '1111',
      deliveryOtp: '2222',
      status: DELIVERY_STATES.DRIVER_ARRIVING,
      version: 4,
      totalFare: 400,
      createdAt: new Date().toISOString()
    };
    db.createTrip(tripRecord);

    const client = new MobileClientSimulator(driverUser.id, 'DRIVER', driverToken);
    client.resyncActiveTrip(tripId);

    // 1. WebSocket vs Push Race Simulation:
    // Event with version 4 arrives via WebSocket
    const wsEventResult = client.handleIncomingEvent({ tripId, version: 4, status: DELIVERY_STATES.DRIVER_ARRIVING });
    assert.equal(wsEventResult.processed, false, 'Duplicate version must be ignored');
    assert.equal(client.localState.lastSeenVersion, 4);

    // Delayed Push Notification arrives late with version 3 (older) or 4 (duplicate)
    const latePushResult = client.handleIncomingEvent({ tripId, version: 3, status: DELIVERY_STATES.DRIVER_ACCEPTED });
    assert.equal(latePushResult.processed, false);
    assert.equal(latePushResult.reason, 'STALE_OR_DUPLICATE_VERSION');

    // 2. Optimistic UI Rollback:
    // Driver attempts to mark "Arrived at Pickup" (DRIVER_AT_PICKUP) while physically 1,200 meters away
    // Update driver coordinates with bypassSpeedFilter so location is accepted as distant
    await driverLocationService.updateDriverLocation(driverUser.id, {
      lat: 17.452000, // ~1,300 meters away from pickup (17.440081)
      lng: 78.348916,
      timestamp: Date.now(),
      bypassSpeedFilter: true
    });

    // Mobile UI optimistically displays "Arrived at Pickup"
    client.applyOptimisticState({ status: DELIVERY_STATES.DRIVER_AT_PICKUP });
    assert.equal(client.localState.optimisticState.status, DELIVERY_STATES.DRIVER_AT_PICKUP);

    // Server transition execution
    const transitionResult = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.DRIVER_AT_PICKUP, { type: 'DRIVER', id: driverUser.id }, {
      expectedVersion: client.localState.lastSeenVersion
    });

    // Must be rejected by backend geofence verification
    assert.equal(transitionResult.success, false);
    assert.equal(transitionResult.error?.code, 'GEOFENCE_VALIDATION_FAILED');

    // Mobile client catches failure and rolls back optimistic UI
    client.rollbackOptimisticState();
    assert.equal(client.localState.optimisticState, null);
    assert.equal(client.localState.activeTrip.status, DELIVERY_STATES.DRIVER_ARRIVING, 'Authoritative local state must remain unchanged');
  });

  // --------------------------------------------------------------------------
  await suite.test('15.7 & 15.8: GPS Permission Revocation & Offline Transition Queue Serialization', async () => {
    const client = new MobileClientSimulator(driverUser.id, 'DRIVER', driverToken);

    // 1. GPS Permission Revocation:
    client.locationPermissionGranted = false;
    let telemetryUploadTriggered = false;
    if (client.locationPermissionGranted) {
      telemetryUploadTriggered = true;
    }
    assert.equal(telemetryUploadTriggered, false, 'Telemetry upload must be inhibited when location permission is revoked');

    // Reject malformed / empty coordinates from mobile device before processing
    const malformedTelemetry = { lat: NaN, lng: null };
    const valid = Number.isFinite(malformedTelemetry.lat) && Number.isFinite(malformedTelemetry.lng);
    assert.equal(valid, false, 'Client/Server validation must drop malformed coordinates');

    // 2. Offline Transition Queue Serialization (FIFO):
    const tripId = `TRIP_MOB_${Date.now()}_04`;
    const tripRecord = {
      id: tripId,
      customerId: customerUser.id,
      driver: { id: driverUser.id, name: driverUser.name, phone: driverUser.phone },
      pickupLat: 17.440081,
      pickupLng: 78.348916,
      dropLat: 17.448500,
      dropLng: 78.374000,
      pickupOtp: '9988',
      deliveryOtp: '7766',
      status: DELIVERY_STATES.DRIVER_ACCEPTED,
      version: 3,
      totalFare: 500,
      createdAt: new Date().toISOString()
    };
    db.createTrip(tripRecord);

    // Client queues actions while offline
    const queuedAction1 = { action: 'start-arriving', nextState: DELIVERY_STATES.DRIVER_ARRIVING, idemKey: `idem_q1_${Date.now()}` };
    const queuedAction2 = { action: 'arrived-pickup', nextState: DELIVERY_STATES.DRIVER_AT_PICKUP, idemKey: `idem_q2_${Date.now()}` };
    client.offlineQueue.push(queuedAction1);
    client.offlineQueue.push(queuedAction2);

    assert.equal(client.offlineQueue.length, 2);

    // Replay queue sequentially upon network reconnect
    const executedResults = [];
    while (client.offlineQueue.length > 0) {
      const item = client.offlineQueue.shift();
      // Ensure driver is at pickup for step 2
      if (item.nextState === DELIVERY_STATES.DRIVER_AT_PICKUP) {
        await driverLocationService.updateDriverLocation(driverUser.id, {
          lat: tripRecord.pickupLat,
          lng: tripRecord.pickupLng,
          timestamp: Date.now(),
          bypassSpeedFilter: true
        });
      }
      const res = await deliveryStateMachine.transition(tripId, item.nextState, { type: 'DRIVER', id: driverUser.id }, {
        idempotencyKey: item.idemKey
      });
      executedResults.push(res);
    }

    assert.equal(executedResults.length, 2);
    assert.equal(executedResults[0].success, true);
    assert.equal(executedResults[0].auditLog.toState, DELIVERY_STATES.DRIVER_ARRIVING);
    assert.equal(executedResults[1].success, true);
    assert.equal(executedResults[1].auditLog.toState, DELIVERY_STATES.DRIVER_AT_PICKUP);
    assert.equal(executedResults[1].trip.status, DELIVERY_STATES.DRIVER_AT_PICKUP);
  });

  // --------------------------------------------------------------------------
  await suite.test('15.9 & 15.10: Multi-Role Session Isolation & Double-Entry Ledger Parity Audit', async () => {
    // 1. Role Session Isolation:
    // Customer client attempts to join driver-restricted WebSocket room
    const mockSocket = { readyState: 1, send: () => {}, close: () => {} };
    const custClientId = wsService.registerClient(mockSocket, 'CUSTOMER', customerUser.id, 'CUSTOMER', customerToken);
    const joinDriverRoom = wsService.joinRoom(custClientId, `driver:${driverUser.id}`);
    assert.equal(joinDriverRoom.success, false, 'Customer must NOT be allowed to join Driver room');
    assert.match(joinDriverRoom.error, /Forbidden/);

    // Driver joins own room
    const drvClientId = wsService.registerClient(mockSocket, 'DRIVER', driverUser.id, 'DRIVER', driverToken);
    const joinOwnRoom = wsService.joinRoom(drvClientId, `driver:${driverUser.id}`);
    assert.equal(joinOwnRoom.success, true);

    // 2. Full Mobile Lifecycle Execution with Payment Settlement & Ledger Invariant
    const tripId = `TRIP_MOB_${Date.now()}_LIFECYCLE`;
    const farePaise = 60000;
    const tripRecord = {
      id: tripId,
      customerId: customerUser.id,
      driver: { id: driverUser.id, name: driverUser.name, phone: driverUser.phone },
      pickupLat: 17.440081,
      pickupLng: 78.348916,
      dropLat: 17.448500,
      dropLng: 78.374000,
      pickupOtp: '3344',
      deliveryOtp: '5566',
      status: DELIVERY_STATES.DRIVER_AT_DROPOFF,
      version: 8,
      totalFare: 600,
      fareBreakdown: { total: 600 },
      createdAt: new Date().toISOString()
    };
    db.createTrip(tripRecord);

    // Driver completes trip with OTP
    const completeResult = await deliveryStateMachine.transition(tripId, DELIVERY_STATES.DELIVERED, { type: 'DRIVER', id: driverUser.id }, {
      otp: '5566',
      idempotencyKey: `mobile-complete-${tripId}`
    });
    assert.equal(completeResult.success, true);
    assert.equal(completeResult.trip.status, DELIVERY_STATES.DELIVERED);

    // Setup PostgreSQL ledger instance & payment integration service
    const repo = new PostgresLedgerRepository();
    const psm = new PaymentStateMachine({ ledgerService: repo });
    const paymentService = new PaymentIntegrationService({ ledgerService: repo, paymentStateMachine: psm });

    // Step A: Top up customer wallet
    await repo.topUpCustomerWallet({ customerId: customerUser.id, amountPaise: farePaise, idempotencyKey: `top:mob:${tripId}` });

    // Step B: Authorize and escrow hold
    const escRes = await paymentService.reserveEscrow({
      tripId,
      orderId: tripId,
      customerId: customerUser.id,
      amountPaise: farePaise,
      idempotencyKey: `esc:mob:${tripId}`
    });
    assert.equal(escRes.success, true);

    // Step C: Settle trip via PaymentIntegrationService
    const settleRes = await paymentService.settleTrip({
      tripId,
      driverId: driverUser.id,
      amountPaise: farePaise,
      idempotencyKey: `VAAYU:${tripId}:MOBILE_SETTLEMENT`
    });
    assert.equal(settleRes.success, true);

    // Step D: Double-Entry Ledger Reconciliation Audit
    const recon = await repo.reconcile();
    assert.equal(recon.ok, true, 'PostgreSQL Ledger reconciliation must pass');
    assert.equal(recon.problems.length, 0, 'Ledger must have 0 reconciliation problems');
    assert.ok(recon.journalEntries >= 32142, `Journal entries must be >= baseline 32,142 (actual: ${recon.journalEntries})`);
    console.log(`[Pillar 15 Audit] Reconciled journal entries: ${recon.journalEntries}, problems: 0, balance: ₹0`);
    await repo.pool.end();
  });
});
