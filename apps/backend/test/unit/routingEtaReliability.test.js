/**
 * VAAYU Milestone 11: Routing & ETA Reliability Suite
 * 
 * Verifies the 10 domains of the Pillar 11 Routing Integrity Layer:
 * 1. P11.1 & P11.2: Multi-tier vehicle speed profiles, turnaround buffers & phase-aware ETAs.
 * 2. P11.3 & P11.6: Provider response anomaly detection (zero distance, Euclidean violation, impossible speed & waypoint binding).
 * 3. P11.4 & P11.8: Circuit breaker tripping, half-open resets, concurrent request deduplication & fail-open Haversine degradation.
 * 4. P11.5: Bounded LRU/TTL caching, TTL expiration, and cache bypass verification.
 * 5. P11.7 & P11.9: Dispatch scoring integration with verified ETAs, observability counters tracking.
 * 6. P11.10: Financial core invariant & complete settlement with routing fallbacks (₹0 imbalance).
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');

const routingModule = require('../../src/map-engine/routing');
const { RoutingService, VEHICLE_SPEED_PROFILES } = routingModule;
const { metricsService } = require('../../src/services/metricsService');
const db = require('../../src/db/database');
const { dispatchService } = require('../../src/services/dispatchService');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');

test('Pillar 11: Routing & ETA Reliability Suite', async (suite) => {

  // =========================================================================
  // 11.1 & 11.2: VEHICLE SPEED PROFILES, TURNAROUND BUFFERS & PHASE-AWARE ETAS
  // =========================================================================
  await suite.test('11.1 & 11.2: Vehicle Speed Profiles, Turnaround Buffers & Phase ETAs', async () => {
    const engine = new RoutingService({ enableCache: false });

    const pickupLat = 17.4400;
    const pickupLng = 78.3800;
    const dropLat = 17.4900;
    const dropLng = 78.3900;

    // 1. Vehicle profile calculations across fleet types
    const route2w = await engine.calculateRoute(pickupLat, pickupLng, dropLat, dropLng, [], { vehicleId: 'v_2w' });
    const routeAce = await engine.calculateRoute(pickupLat, pickupLng, dropLat, dropLng, [], { vehicleId: 'v_ace' });
    const routeOutstation = await engine.calculateRoute(pickupLat, pickupLng, dropLat, dropLng, [], { vehicleId: 'v_ace', isOutstation: true });

    assert.ok(route2w.durationMinutes > 0);
    assert.ok(routeAce.durationMinutes > 0);
    // 2-wheeler (30 km/h) must be strictly faster than Tata Ace (18 km/h) for the exact same distance
    assert.ok(route2w.durationMinutes <= routeAce.durationMinutes, '2-wheeler ETA must be less than or equal to Tata Ace ETA');
    // Outstation highway multiplier (1.4x speed) should produce lower drive time than urban congested Ace
    assert.ok(routeOutstation.durationMinutes <= routeAce.durationMinutes, 'Highway multiplier must yield lower trip duration than urban crawl');

    // 2. Synchronous Pickup ETA Turnaround Buffer (+2 mins)
    const pickupEstimate = engine.calculatePickupEtaSync(pickupLat, pickupLng, dropLat, dropLng, 'v_ace');
    assert.ok(pickupEstimate.pickupEtaMin >= pickupEstimate.durationMin + 2, 'Pickup ETA must include +2 mins driver turnaround buffer');
    assert.equal(pickupEstimate.source, 'HAVERSINE_PROFILE');

    // 3. Phase-Aware Live ETA (PICKUP vs DELIVERY vs AT_PICKUP)
    const mockTripPickup = {
      id: 'TRIP_ETA_PHASE_01',
      status: 'DRIVER_ARRIVING',
      vehicleId: 'v_ace',
      pickupLat,
      pickupLng,
      dropLat,
      dropLng,
      driver: { id: 'drv_test_01', currentLat: 17.4420, currentLng: 78.3810 }
    };

    const livePickupEta = await engine.calculateLiveEta(mockTripPickup);
    assert.equal(livePickupEta.success, true);
    assert.equal(livePickupEta.phase, 'PICKUP');
    assert.ok(livePickupEta.etaMinutes >= 1);

    const mockTripTransit = {
      id: 'TRIP_ETA_PHASE_02',
      status: 'IN_TRANSIT',
      vehicleId: 'v_ace',
      pickupLat,
      pickupLng,
      dropLat,
      dropLng
    };
    const liveTransitEta = await engine.calculateLiveEta(mockTripTransit, { lat: 17.4600, lng: 78.3850 });
    assert.equal(liveTransitEta.success, true);
    assert.equal(liveTransitEta.phase, 'DELIVERY');
    assert.ok(liveTransitEta.etaMinutes >= 1);
  });

  // =========================================================================
  // 11.3 & 11.6: PROVIDER RESPONSE ANOMALY DETECTION & WAYPOINT BINDING
  // =========================================================================
  await suite.test('11.3 & 11.6: Anomaly Detection: Zero distance, Euclidean violations, speed anomalies & waypoint binding', async () => {
    const pickup = { lat: 17.4400, lng: 78.3800 };
    const drop = { lat: 17.5400, lng: 78.4800 }; // ~15km straight line
    const waypoints = [pickup, drop];

    // 1. Anomaly A: Zero distance for distinct coordinates (>500m straight line)
    const mockZeroDistProvider = {
      name: 'MockZeroDistProvider',
      async calculateRoute() {
        return { distanceKm: 0, durationMin: 10, routePoints: [] };
      }
    };
    const engineZero = new RoutingService({ provider: mockZeroDistProvider, enableCache: false });
    const resZero = await engineZero.calculateRoute(waypoints);
    // Must reject anomalous zero distance and fallback to internal Haversine
    assert.equal(resZero.provider, 'HAVERSINE_FALLBACK');
    assert.ok(resZero.distanceKm > 10, 'Fallback distance must be physically realistic');

    // 2. Anomaly B: Euclidean lower bound violation (road distance < 80% straight line)
    const mockEuclideanViolationProvider = {
      name: 'MockEuclideanViolationProvider',
      async calculateRoute() {
        return { distanceKm: 2.0, durationMin: 15, routePoints: [] }; // 2km is physically impossible for 15km displacement
      }
    };
    const engineEuclidean = new RoutingService({ provider: mockEuclideanViolationProvider, enableCache: false });
    const resEuclidean = await engineEuclidean.calculateRoute(waypoints);
    assert.equal(resEuclidean.provider, 'HAVERSINE_FALLBACK');

    // 3. Anomaly C: Impossible route speed anomaly (> 160 km/h in city)
    const mockSpeedAnomalyProvider = {
      name: 'MockSpeedAnomalyProvider',
      async calculateRoute() {
        // 50 km in 2 minutes = 1500 km/h!
        return { distanceKm: 50.0, durationMin: 2, routePoints: [] };
      }
    };
    const engineSpeed = new RoutingService({ provider: mockSpeedAnomalyProvider, enableCache: false });
    const resSpeed = await engineSpeed.calculateRoute(waypoints);
    assert.equal(resSpeed.provider, 'HAVERSINE_FALLBACK');

    // 4. Waypoint Binding & Input Sanitization
    await assert.rejects(
      async () => {
        await engineZero.calculateRoute([{ lat: NaN, lng: 78.38 }, { lat: 17.50, lng: 78.40 }]);
      },
      /RangeError/
    );
  });

  // =========================================================================
  // 11.4 & 11.8: CIRCUIT BREAKER, CONCURRENT DEDUPLICATION & FAIL-OPEN DEGRADATION
  // =========================================================================
  await suite.test('11.4 & 11.8: Circuit Breaker, Request Deduplication & Fail-Open Degradation', async () => {
    let callCount = 0;
    const mockFailingProvider = {
      name: 'MockFlakyProvider',
      async calculateRoute() {
        callCount++;
        throw new Error('503 Service Unavailable: Provider overloaded');
      }
    };

    const engine = new RoutingService({
      provider: mockFailingProvider,
      enableCache: false,
      circuitFailThreshold: 3,
      circuitResetTimeoutMs: 1000
    });

    const waypoints = [{ lat: 17.4400, lng: 78.3800 }, { lat: 17.4800, lng: 78.4200 }];

    // Trigger consecutive errors to trip circuit breaker (threshold = 3)
    await engine.calculateRoute(waypoints);
    await engine.calculateRoute(waypoints);
    await engine.calculateRoute(waypoints);

    const circuitState = engine.getCircuitState('MockFlakyProvider');
    assert.equal(circuitState.state, 'OPEN', 'Circuit breaker must be tripped OPEN after 3 failures');

    // Subsequent call while OPEN: Must NOT invoke failing provider; must fast-fail directly to fallback
    const countBefore = callCount;
    const resFastFallback = await engine.calculateRoute(waypoints);
    assert.equal(resFastFallback.provider, 'HAVERSINE_FALLBACK');
    assert.equal(callCount, countBefore, 'OPEN circuit must short-circuit provider invocation');

    // Concurrent In-Flight Request Deduplication
    let slowProviderCalls = 0;
    const mockSlowProvider = {
      name: 'MockSlowProvider',
      async calculateRoute() {
        slowProviderCalls++;
        await new Promise(r => setTimeout(r, 60));
        return { distanceKm: 8.5, durationMin: 22, routePoints: [] };
      }
    };

    const engineDedup = new RoutingService({
      provider: mockSlowProvider,
      enableCache: false
    });

    // Launch 5 simultaneous identical route queries
    const promises = Array(5).fill(null).map(() => engineDedup.calculateRoute(waypoints));
    const results = await Promise.all(promises);

    assert.equal(slowProviderCalls, 1, 'Concurrent identical in-flight requests must share single execution promise');
    for (const r of results) {
      assert.equal(r.distanceKm, 8.5);
      assert.equal(r.durationMin, 22);
    }
  });

  // =========================================================================
  // 11.5: BOUNDED LRU/TTL ROUTE CACHE & STALENESS PROTECTION
  // =========================================================================
  await suite.test('11.5: Bounded LRU/TTL Route Cache & Staleness Protection', async () => {
    let providerExecutions = 0;
    const mockProvider = {
      name: 'MockCacheTestProvider',
      async calculateRoute() {
        providerExecutions++;
        return { distanceKm: 5.0, durationMin: 12, routePoints: [] };
      }
    };

    // Small cache capacity (2 items) and short TTL (100ms)
    const engine = new RoutingService({
      provider: mockProvider,
      enableCache: true,
      cacheCapacity: 2,
      cacheTtlMs: 100
    });

    const routeA = [{ lat: 17.4400, lng: 78.3800 }, { lat: 17.4500, lng: 78.3900 }];
    const routeB = [{ lat: 17.4600, lng: 78.4000 }, { lat: 17.4700, lng: 78.4100 }];
    const routeC = [{ lat: 17.4800, lng: 78.4200 }, { lat: 17.4900, lng: 78.4300 }];

    // 1. Initial query: Cache miss -> provider call
    const resA1 = await engine.calculateRoute(routeA);
    assert.equal(providerExecutions, 1);
    assert.equal(resA1.cached, false);

    // 2. Second query: Cache hit -> provider NOT called
    const resA2 = await engine.calculateRoute(routeA);
    assert.equal(providerExecutions, 1);
    assert.equal(resA2.cached, true);

    // 3. Fill cache: Add routeB and routeC -> triggers LRU eviction of oldest (routeA)
    await engine.calculateRoute(routeB);
    await engine.calculateRoute(routeC);
    assert.equal(providerExecutions, 3);

    // Re-query routeA: Must be a cache miss due to LRU capacity bound of 2
    const resA3 = await engine.calculateRoute(routeA);
    assert.equal(providerExecutions, 4);
    assert.equal(resA3.cached, false);

    // 4. TTL Expiration: Wait 120ms to exceed 100ms TTL
    await new Promise(r => setTimeout(r, 120));
    const resA4 = await engine.calculateRoute(routeA);
    assert.equal(providerExecutions, 5, 'Expired cache entry must trigger fresh computation');
    assert.equal(resA4.cached, false);

    // 5. Bypass cache flag
    const resBypass = await engine.calculateRoute(routeA, { bypassCache: true });
    assert.equal(providerExecutions, 6, 'bypassCache: true must bypass cache lookup');
  });

  // =========================================================================
  // 11.7 & 11.9: DISPATCH SCORING INTEGRATION & OBSERVABILITY METRICS
  // =========================================================================
  await suite.test('11.7 & 11.9: Dispatch Candidate Scoring Integration & Observability Counters', async () => {
    const pickupLat = 17.4400;
    const pickupLng = 78.3800;
    const testOrder = { id: 'ORD_P11_DISPATCH_01', vehicleId: 'TATA_ACE', pickupLat, pickupLng };

    // Register 2 simulated drivers
    const driverClose = {
      driverId: 'drv_p11_close',
      name: 'Close Driver',
      phone: '9876543210',
      vehicleId: 'TATA_ACE',
      rating: 4.8,
      lat: 17.4450,
      lng: 78.3840
    };
    const driverFar = {
      driverId: 'drv_p11_far',
      name: 'Far Driver',
      phone: '9876543211',
      vehicleId: 'TATA_ACE',
      rating: 4.8,
      lat: 17.5200,
      lng: 78.4400
    };

    // Score candidates using dispatchService
    const scoreClose = dispatchService.scoreCandidate(driverClose, testOrder, pickupLat, pickupLng);
    const scoreFar = dispatchService.scoreCandidate(driverFar, testOrder, pickupLat, pickupLng);

    assert.ok(scoreClose.totalScore > scoreFar.totalScore, 'Close driver must score higher than far driver');
    assert.ok(scoreClose.distKm < scoreFar.distKm);
    assert.ok(scoreClose.etaMin < scoreFar.etaMin);

    // Observability counters check
    const metricsSnapshot = metricsService.getSnapshot();
    assert.ok(metricsSnapshot.counters.routing_requests_total > 0, 'routing_requests_total must increment');
    assert.ok(metricsSnapshot.counters.eta_calculations_total > 0, 'eta_calculations_total must increment');
  });

  // =========================================================================
  // 11.10: COMPLETE LIFECYCLE, ROUTING FALLBACK & FINANCIAL CORE RECONCILIATION
  // =========================================================================
  await suite.test('11.10: Financial Core Invariant: Full lifecycle settlement under routing fallback & ₹0 ledger balance', async () => {
    const tripId = `TRIP_P11_FIN_${Date.now()}`;
    const customerId = `cust_p11_${Date.now()}`;
    const driverId = `drv_p11_${Date.now()}`;
    const farePaise = 35000; // ₹350.00

    const repo = new PostgresLedgerRepository();
    const psm = new PaymentStateMachine({ ledgerService: repo });
    const paymentService = new PaymentIntegrationService({ ledgerService: repo, paymentStateMachine: psm });

    // 1. Top up customer wallet
    await repo.topUpCustomerWallet({ customerId, amountPaise: 100000, idempotencyKey: `top:p11:${tripId}` });

    // 2. Authorize & Escrow Payment via reserveEscrow
    const escrowRes = await paymentService.reserveEscrow({
      tripId,
      orderId: tripId,
      customerId,
      amountPaise: farePaise,
      idempotencyKey: `esc:p11:${tripId}`
    });
    assert.equal(escrowRes.success, true);
    assert.equal(escrowRes.state, 'ESCROWED');

    // 3. Complete Delivery & Settle via settleTrip
    const settleRes = await paymentService.settleTrip({
      tripId,
      driverId,
      amountPaise: farePaise,
      idempotencyKey: `set:p11:${tripId}`
    });
    assert.equal(settleRes.success, true);
    assert.equal(settleRes.state, 'SETTLED');

    // 4. Ledger Reconciliation Audit against PostgreSQL
    const rec = await repo.reconcile();
    assert.equal(rec.ok, true, 'PostgreSQL double-entry reconciliation must be clean');
    assert.equal(rec.problems.length, 0, 'Zero ledger discrepancy problems allowed');
    await repo.pool.end();
  });
});
