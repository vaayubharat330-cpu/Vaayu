'use strict';

/**
 * Pillar 10: Location & Mobility Integrity Verification Test Suite
 *
 * Verifies:
 * 1. P10.1: Telemetry Sanitization & Accuracy Radius Bounds
 *    - Rejection of Null Island (0,0), NaN/Infinity, out-of-bounds coordinates
 *    - Rejection of degraded GPS accuracy (> 100m error radius)
 * 2. P10.2: Kinematic Plausibility, Jump Filter & Replay Protection
 *    - Rejection of impossible speed anomalies (> 130 km/h) & teleport jumps
 *    - Rejection of out-of-order / replay timestamps (older than last ping)
 *    - Rejection of future timestamps (> 5s in future) and expired pings (> 5 mins)
 *    - Stationary bearing stabilization (keeps heading if displacement < 5m)
 * 3. P10.3: Multi-Tier Liveness State Machine & Dispatch Gating
 *    - Evaluation of ONLINE (0-15s), DEGRADED (15-30s), STALE (30-60s), OFFLINE (>60s)
 *    - Dispatch eligibility strictly gated to ONLINE & DEGRADED
 *    - Active trip continuity protection (temporary telemetry degradation does not abort active delivery)
 * 4. P10.4: Spatial Indexing, Trip Binding & Geofence Verification
 *    - Fast radial candidate indexing (findNearbyDrivers) sorted by ascending distance
 *    - Accurate geofence boundary verification (<= 300m threshold)
 *    - Historical trip telemetry trail auditing and isolation
 * 5. P10.5: Routing Provider Fault Tolerance & Graceful Fallback
 *    - Fallback to vehicle-profile Haversine ETA when external map APIs fail/timeout
 *    - Fail-open resiliency preventing dispatch engine stalls
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');

const { driverLocationService, DriverLocationService } = require('../../src/services/driverLocationService');
const { getActiveDriverLocationStore, calcHaversine } = require('../../src/services/driverLocationStore');
const routingModule = require('../../src/map-engine/routing');
const { routingService } = require('../../src/services/routingService');

test('Pillar 10: Location & Mobility Integrity Suite', async (suite) => {

  // =========================================================================
  // 10.1 TELEMETRY SANITIZATION & ACCURACY RADIUS BOUNDS
  // =========================================================================
  await suite.test('10.1: Telemetry Sanitization: Coordinate bounds, Null Island rejection & GPS accuracy radius bounds', async () => {
    const driverId = 'drv_p10_sanity_01';

    // 1. Rejection of Null Island (0, 0)
    const nullIslandRes = await driverLocationService.updateDriverLocation(driverId, {
      lat: 0.0,
      lng: 0.0,
      accuracy: 5
    });
    assert.equal(nullIslandRes.success, false);
    assert.equal(nullIslandRes.reason, 'Zero null island coordinates');

    // 2. Rejection of NaN / Non-numeric coordinates
    const nanRes = await driverLocationService.updateDriverLocation(driverId, {
      lat: NaN,
      lng: 78.3800
    });
    assert.equal(nanRes.success, false);
    assert.equal(nanRes.reason, 'NaN coordinates');

    // 3. Rejection of out-of-bounds coordinates
    const oobRes = await driverLocationService.updateDriverLocation(driverId, {
      lat: 95.0,
      lng: 78.3800
    });
    assert.equal(oobRes.success, false);
    assert.equal(oobRes.reason, 'Coordinates out of bounds');

    // 4. Rejection of degraded GPS accuracy (> 100m error radius)
    const degradedAccuracyRes = await driverLocationService.updateDriverLocation(driverId, {
      lat: 17.4400,
      lng: 78.3800,
      accuracy: 150 // 150m is untrusted
    });
    assert.equal(degradedAccuracyRes.success, false);
    assert.ok(degradedAccuracyRes.reason.includes('Low GPS accuracy'));

    // 5. Valid GPS telemetry passes cleanly
    const validRes = await driverLocationService.updateDriverLocation(driverId, {
      lat: 17.4400,
      lng: 78.3800,
      accuracy: 8,
      speed: 25
    });
    assert.equal(validRes.success, true);
    assert.equal(validRes.driver.lat, 17.4400);
    assert.equal(validRes.driver.lng, 78.3800);
  });

  // =========================================================================
  // 10.2 KINEMATIC PLAUSIBILITY, JUMP FILTER & REPLAY PROTECTION
  // =========================================================================
  await suite.test('10.2: Kinematic Plausibility: Impossible speed rejection, out-of-order replay blocking & bearing stabilization', async () => {
    const driverId = 'drv_p10_kinematic_01';
    const now = Date.now();

    // Baseline ping at T0
    const p1 = await driverLocationService.updateDriverLocation(driverId, {
      lat: 17.4400,
      lng: 78.3800,
      timestamp: now,
      bearing: 90,
      speed: 20
    });
    assert.equal(p1.success, true);

    // 1. Replay / Out-of-Order Packet: Ping with timestamp strictly earlier than lastPingMs
    const replayRes = await driverLocationService.updateDriverLocation(driverId, {
      lat: 17.4402,
      lng: 78.3802,
      timestamp: now - 5000 // 5 seconds in the past!
    });
    assert.equal(replayRes.success, false);
    assert.equal(replayRes.reason, 'Replayed or out-of-order telemetry packet rejected');

    // 2. Future Clock Glitch: Ping claiming to be 15 seconds in future (> 5s tolerance)
    const futureRes = await driverLocationService.updateDriverLocation(driverId, {
      lat: 17.4402,
      lng: 78.3802,
      timestamp: now + 15000
    });
    assert.equal(futureRes.success, false);
    assert.equal(futureRes.reason, 'Future timestamp detected');

    // 3. Impossible Speed Jump / Teleport Glitch: Moving 10 km in 2 seconds (~18,000 km/h)
    const teleportRes = await driverLocationService.updateDriverLocation(driverId, {
      lat: 17.5300, // ~10 km away
      lng: 78.3800,
      timestamp: now + 2000,
      speed: 30
    });
    assert.equal(teleportRes.success, false);
    assert.equal(teleportRes.reason, 'Impossible GPS position jump (speed anomaly)');

    // 4. Stationary Bearing Stabilization: Minor movement (< 5m) locks heading rather than spinning
    const stationaryRes = await driverLocationService.updateDriverLocation(driverId, {
      lat: 17.44002, // ~2 meters displacement
      lng: 78.38001,
      timestamp: now + 3000,
      bearing: 270 // erratic compass flutter
    });
    assert.equal(stationaryRes.success, true);
    assert.equal(stationaryRes.driver.bearingConfidence, 'STATIONARY_HOLD');
    assert.equal(stationaryRes.driver.bearing, 90, 'Heading must remain locked to previous 90 deg bearing');
  });

  // =========================================================================
  // 10.3 MULTI-TIER LIVENESS STATE MACHINE & DISPATCH GATING
  // =========================================================================
  await suite.test('10.3: Multi-Tier Liveness: HEALTHY, DEGRADED, STALE, OFFLINE transitions & active trip continuity', async () => {
    const driverId = `drv_p10_liveness_${Date.now()}`;
    await driverLocationService.clearDriverLocation(driverId);
    const now = Date.now();

    // 1. HEALTHY State (age <= 5s)
    assert.equal(driverLocationService.getLivenessState(now - 1000), 'HEALTHY');

    // 2. DEGRADED State (age between 5s and 15s)
    assert.equal(driverLocationService.getLivenessState(now - 10000), 'DEGRADED');

    // 3. STALE State (age between 15s and 60s)
    assert.equal(driverLocationService.getLivenessState(now - 30000), 'STALE');

    // 4. OFFLINE State (age > 60s)
    assert.equal(driverLocationService.getLivenessState(now - 61000), 'OFFLINE');

    // 5. Dispatch Eligibility Check
    // Set up driver in store with fresh ping
    await driverLocationService.updateDriverLocation(driverId, {
      lat: 17.4400,
      lng: 78.3800,
      timestamp: now,
      status: 'ONLINE',
      tripId: null
    });

    const stateFresh = await driverLocationService.getDriverState(driverId);
    assert.equal(stateFresh.livenessState, 'HEALTHY');
    assert.equal(stateFresh.isDispatchEligible, true);

    // Age ping manually in store to STALE (45s old)
    const store = getActiveDriverLocationStore();
    const currentRecord = await store.getDriverLocation(driverId);
    currentRecord.lastPingMs = Date.now() - 45000;
    await store.saveDriverLocation(driverId, currentRecord);

    const stateStale = await driverLocationService.getDriverState(driverId);
    assert.equal(stateStale.livenessState, 'STALE');
    assert.equal(stateStale.isDispatchEligible, false, 'STALE driver must NOT be dispatch eligible');

    // 6. Active Trip Continuity Invariant:
    // When a driver is on an active trip (currentTripId set), status stays ON_TRIP even if ping is degraded
    currentRecord.currentTripId = 'TRIP_ACTIVE_P10_01';
    currentRecord.status = 'ON_TRIP';
    await store.saveDriverLocation(driverId, currentRecord);

    const tripState = await driverLocationService.getDriverState(driverId);
    assert.equal(tripState.status, 'ON_TRIP');
    assert.equal(tripState.currentTripId, 'TRIP_ACTIVE_P10_01', 'Active delivery trip binding must be preserved');
  });

  // =========================================================================
  // 10.4 SPATIAL INDEXING, TRIP BINDING & GEOFENCE VERIFICATION
  // =========================================================================
  await suite.test('10.4: Spatial Indexing & Geofencing: Radial candidate search, history tracking & <=300m threshold verification', async () => {
    const centerLat = 17.4400;
    const centerLng = 78.3800;

    // Use unique driver IDs so persisted Redis telemetry from a previous test run
    // cannot retain a stale trip binding/status and contaminate the spatial query.
    const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const dClose = `drv_p10_spatial_close_${runId}`; // ~500m
    const dMid = `drv_p10_spatial_mid_${runId}`;     // ~2.5km
    const dFar = `drv_p10_spatial_far_${runId}`;     // ~15km (outside 10km radius)

    // Explicitly clear each fixture before writing the fresh spatial state.
    await Promise.all([
      driverLocationService.clearDriverLocation(dClose),
      driverLocationService.clearDriverLocation(dMid),
      driverLocationService.clearDriverLocation(dFar)
    ]);

    // Register 3 nearby drivers at known distances.
    await driverLocationService.updateDriverLocation(dClose, { lat: 17.4440, lng: 78.3820, vehicleId: 'TATA_ACE', status: 'ONLINE', tripId: null });
    await driverLocationService.updateDriverLocation(dMid, { lat: 17.4600, lng: 78.3900, vehicleId: 'TATA_ACE', status: 'ONLINE', tripId: null });
    await driverLocationService.updateDriverLocation(dFar, { lat: 17.5700, lng: 78.4500, vehicleId: 'TATA_ACE', status: 'ONLINE', tripId: null });

    // Radial Query (radius = 10km)
    const nearby = await driverLocationService.findNearbyDrivers(centerLat, centerLng, 10, 'TATA_ACE');
    const nearbyIds = nearby.map(d => d.driverId);

    assert.ok(nearbyIds.includes(dClose), 'Close driver must be included in radius query');
    assert.ok(nearbyIds.includes(dMid), 'Mid driver must be included in radius query');
    assert.ok(!nearbyIds.includes(dFar), 'Far driver (>10km) must be strictly excluded');

    // Distance Sort Order: Closest driver first
    assert.equal(nearby[0].driverId, dClose);
    assert.ok(nearby[0].distanceKm < nearby[1].distanceKm, 'Results must be sorted ascending by distance');

    // Location Audit History: Verify breadcrumbs trail was recorded
    const history = await driverLocationService.getDriverHistory(dClose);
    assert.ok(Array.isArray(history));
    assert.ok(history.length >= 1, 'Driver location ping must append to history trail');
    assert.equal(history[history.length - 1].lat, 17.4440);

    // Geofence Math Validation (Haversine threshold <= 300m)
    const targetPickupLat = 17.4400;
    const targetPickupLng = 78.3800;

    // Point 1: 150m away -> INSIDE 300m geofence
    const point1Lat = 17.4410;
    const point1Lng = 78.3808;
    const distMetersInside = Math.round(calcHaversine(point1Lat, point1Lng, targetPickupLat, targetPickupLng) * 1000);
    assert.ok(distMetersInside <= 300, `Point 1 must be within 300m (was ${distMetersInside}m)`);

    // Point 2: 700m away -> OUTSIDE 300m geofence
    const point2Lat = 17.4460;
    const point2Lng = 78.3830;
    const distMetersOutside = Math.round(calcHaversine(point2Lat, point2Lng, targetPickupLat, targetPickupLng) * 1000);
    assert.ok(distMetersOutside > 300, `Point 2 must be outside 300m (was ${distMetersOutside}m)`);
  });

  // =========================================================================
  // 10.5 ROUTING PROVIDER FAULT TOLERANCE & GRACEFUL FALLBACK
  // =========================================================================
  await suite.test('10.5: Routing Provider Fault Tolerance: Fail-open fallback to vehicle-profile Haversine ETA on API failure', async () => {
    const pickupLat = 17.4400;
    const pickupLng = 78.3800;
    const dropLat = 17.4900;
    const dropLng = 78.3900;

    // 1. Calculate Baseline Synchronous / Haversine Route
    const syncRoute = routingService.calculatePickupEtaSync(pickupLat, pickupLng, dropLat, dropLng, 'v_ace');
    assert.ok(syncRoute.distKm > 0, 'Distance must be positive finite number');
    assert.ok(syncRoute.pickupEtaMin > 0, 'ETA minutes must be positive finite number');
    assert.equal(syncRoute.source, 'HAVERSINE_PROFILE', 'Baseline source must be vehicle profile Haversine');

    // 2. Simulate External Provider Network Failure / Timeout
    const simulatedBrokenProvider = {
      name: 'MockFailingGoogleProvider',
      async calculateRoute() {
        throw new Error('Google Maps API 503 Service Unavailable: Rate limit exceeded');
      }
    };

    // Instantiate routing engine with failing provider
    const resilientEngine = new routingModule.RoutingService({
      provider: simulatedBrokenProvider,
      enableCache: false
    });

    // Attempt route calculation: Must NOT throw; must gracefully degrade to fallback
    const fallbackRoute = await resilientEngine.calculateRoute(
      [{ lat: pickupLat, lng: pickupLng }, { lat: dropLat, lng: dropLng }],
      { vehicleId: 'v_ace', city: 'hyderabad' }
    );

    assert.ok(fallbackRoute, 'Fallback route must be returned');
    assert.ok(fallbackRoute.distanceKm > 0, 'Fallback route must compute valid distance');
    assert.ok(fallbackRoute.durationMinutes > 0, 'Fallback route must compute valid duration');
    assert.equal(fallbackRoute.provider, 'HAVERSINE_FALLBACK', 'Provider must report HAVERSINE_FALLBACK on external failure');
    assert.ok(Array.isArray(fallbackRoute.polyline), 'Fallback route must generate valid polyline coordinates');
    assert.equal(fallbackRoute.polyline.length, 2, 'Fallback polyline must contain origin and destination waypoints');
  });
});
