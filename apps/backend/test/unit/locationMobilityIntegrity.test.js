'use strict';

/**
 * Pillar 10: Location & Mobility Integrity Verification Test Suite
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');

const { driverLocationService } = require('../../src/services/driverLocationService');
const { getActiveDriverLocationStore, calcHaversine } = require('../../src/services/driverLocationStore');
const routingModule = require('../../src/map-engine/routing');
const { routingService } = require('../../src/services/routingService');

test('Pillar 10: Location & Mobility Integrity Suite', async (suite) => {
  await suite.test('10.1: Telemetry Sanitization: Coordinate bounds, Null Island rejection & GPS accuracy radius bounds', async () => {
    const driverId = 'drv_p10_sanity_01';
    const nullIslandRes = await driverLocationService.updateDriverLocation(driverId, { lat: 0.0, lng: 0.0, accuracy: 5 });
    assert.equal(nullIslandRes.success, false); assert.equal(nullIslandRes.reason, 'Zero null island coordinates');
    const nanRes = await driverLocationService.updateDriverLocation(driverId, { lat: NaN, lng: 78.3800 });
    assert.equal(nanRes.success, false); assert.equal(nanRes.reason, 'NaN coordinates');
    const oobRes = await driverLocationService.updateDriverLocation(driverId, { lat: 95.0, lng: 78.3800 });
    assert.equal(oobRes.success, false); assert.equal(oobRes.reason, 'Coordinates out of bounds');
    const degradedAccuracyRes = await driverLocationService.updateDriverLocation(driverId, { lat: 17.4400, lng: 78.3800, accuracy: 150 });
    assert.equal(degradedAccuracyRes.success, false); assert.ok(degradedAccuracyRes.reason.includes('Low GPS accuracy'));
    const validRes = await driverLocationService.updateDriverLocation(driverId, { lat: 17.4400, lng: 78.3800, accuracy: 8, speed: 25 });
    assert.equal(validRes.success, true); assert.equal(validRes.driver.lat, 17.4400); assert.equal(validRes.driver.lng, 78.3800);
  });

  await suite.test('10.2: Kinematic Plausibility: Impossible speed rejection, out-of-order replay blocking & bearing stabilization', async () => {
    const driverId = 'drv_p10_kinematic_01'; const now = Date.now();
    const p1 = await driverLocationService.updateDriverLocation(driverId, { lat: 17.4400, lng: 78.3800, timestamp: now, bearing: 90, speed: 20 });
    assert.equal(p1.success, true);
    const replayRes = await driverLocationService.updateDriverLocation(driverId, { lat: 17.4402, lng: 78.3802, timestamp: now - 5000 });
    assert.equal(replayRes.success, false); assert.equal(replayRes.reason, 'Replayed or out-of-order telemetry packet rejected');
    const futureRes = await driverLocationService.updateDriverLocation(driverId, { lat: 17.4402, lng: 78.3802, timestamp: now + 15000 });
    assert.equal(futureRes.success, false); assert.equal(futureRes.reason, 'Future timestamp detected');
    const teleportRes = await driverLocationService.updateDriverLocation(driverId, { lat: 17.5300, lng: 78.3800, timestamp: now + 2000, speed: 30 });
    assert.equal(teleportRes.success, false); assert.equal(teleportRes.reason, 'Impossible GPS position jump (speed anomaly)');
    const stationaryRes = await driverLocationService.updateDriverLocation(driverId, { lat: 17.44002, lng: 78.38001, timestamp: now + 3000, bearing: 270 });
    assert.equal(stationaryRes.success, true); assert.equal(stationaryRes.driver.bearingConfidence, 'STATIONARY_HOLD'); assert.equal(stationaryRes.driver.bearing, 90);
  });

  await suite.test('10.3: Multi-Tier Liveness: HEALTHY, DEGRADED, STALE, OFFLINE transitions & active trip continuity', async () => {
    const driverId = `drv_p10_liveness_${Date.now()}`; await driverLocationService.clearDriverLocation(driverId); const now = Date.now();
    assert.equal(driverLocationService.getLivenessState(now - 1000), 'HEALTHY'); assert.equal(driverLocationService.getLivenessState(now - 10000), 'DEGRADED'); assert.equal(driverLocationService.getLivenessState(now - 30000), 'STALE'); assert.equal(driverLocationService.getLivenessState(now - 61000), 'OFFLINE');
    await driverLocationService.updateDriverLocation(driverId, { lat: 17.4400, lng: 78.3800, timestamp: now, status: 'ONLINE', tripId: null });
    const stateFresh = await driverLocationService.getDriverState(driverId); assert.equal(stateFresh.livenessState, 'HEALTHY'); assert.equal(stateFresh.isDispatchEligible, true);
    const store = getActiveDriverLocationStore(); const currentRecord = await store.getDriverLocation(driverId); currentRecord.lastPingMs = Date.now() - 45000; await store.saveDriverLocation(driverId, currentRecord);
    const stateStale = await driverLocationService.getDriverState(driverId); assert.equal(stateStale.livenessState, 'STALE'); assert.equal(stateStale.isDispatchEligible, false);
    currentRecord.currentTripId = 'TRIP_ACTIVE_P10_01'; currentRecord.status = 'ON_TRIP'; await store.saveDriverLocation(driverId, currentRecord);
    const tripState = await driverLocationService.getDriverState(driverId); assert.equal(tripState.status, 'ON_TRIP'); assert.equal(tripState.currentTripId, 'TRIP_ACTIVE_P10_01');
  });

  await suite.test('10.4: Spatial Indexing & Geofencing: Radial candidate search, history tracking & <=300m threshold verification', async () => {
    const centerLat = 17.4400; const centerLng = 78.3800;
    const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const dClose = `drv_p10_spatial_close_${runId}`; const dMid = `drv_p10_spatial_mid_${runId}`; const dFar = `drv_p10_spatial_far_${runId}`;
    await Promise.all([driverLocationService.clearDriverLocation(dClose), driverLocationService.clearDriverLocation(dMid), driverLocationService.clearDriverLocation(dFar)]);

    const closeWrite = await driverLocationService.updateDriverLocation(dClose, { lat: 17.4440, lng: 78.3820, vehicleId: 'TATA_ACE', status: 'ONLINE', tripId: null });
    const midWrite = await driverLocationService.updateDriverLocation(dMid, { lat: 17.4600, lng: 78.3900, vehicleId: 'TATA_ACE', status: 'ONLINE', tripId: null });
    const farWrite = await driverLocationService.updateDriverLocation(dFar, { lat: 17.5700, lng: 78.4500, vehicleId: 'TATA_ACE', status: 'ONLINE', tripId: null });
    assert.equal(closeWrite.success, true, 'Close spatial fixture must be accepted'); assert.equal(midWrite.success, true, 'Mid spatial fixture must be accepted'); assert.equal(farWrite.success, true, 'Far spatial fixture must be accepted');

    const nearby = await driverLocationService.findNearbyDrivers(centerLat, centerLng, 10, 'TATA_ACE');
    const nearbyIds = new Set(nearby.map(d => d.driverId));
    console.log('[P10.4 DIAG] store=', getActiveDriverLocationStore().constructor.name);
    console.log('[P10.4 DIAG] nearby=', JSON.stringify(nearby, null, 2));
    console.log('[P10.4 DIAG] fixtureIds=', JSON.stringify({ dClose, dMid, dFar }));
    assert.ok(nearbyIds.has(dClose), `Close driver missing; nearbyIds=${JSON.stringify([...nearbyIds])}`);
    assert.ok(nearbyIds.has(dMid), `Mid driver missing; nearbyIds=${JSON.stringify([...nearbyIds])}`);
    assert.ok(!nearbyIds.has(dFar), `Far driver incorrectly included; nearbyIds=${JSON.stringify([...nearbyIds])}`);
    const closeResult = nearby.find(d => d.driverId === dClose); const midResult = nearby.find(d => d.driverId === dMid);
    assert.ok(closeResult, 'Close fixture result must be present'); assert.ok(midResult, 'Mid fixture result must be present');
    assert.ok(closeResult.distanceKm < midResult.distanceKm, `Fixture distances not ordered: close=${closeResult?.distanceKm}, mid=${midResult?.distanceKm}`);
    const fixtureResults = nearby.filter(d => d.driverId === dClose || d.driverId === dMid);
    assert.deepEqual(fixtureResults.map(d => d.driverId), [dClose, dMid], `Controlled fixture ordering mismatch: ${JSON.stringify(fixtureResults)}`);

    const history = await driverLocationService.getDriverHistory(dClose);
    console.log('[P10.4 DIAG] history=', JSON.stringify(history, null, 2));
    assert.ok(Array.isArray(history)); assert.ok(history.length >= 1, `History missing; length=${history.length}`); assert.equal(history[history.length - 1].lat, 17.4440);

    const targetPickupLat = 17.4400; const targetPickupLng = 78.3800;
    const point1Lat = 17.4410; const point1Lng = 78.3808; const distMetersInside = Math.round(calcHaversine(point1Lat, point1Lng, targetPickupLat, targetPickupLng) * 1000);
    const point2Lat = 17.4460; const point2Lng = 78.3830; const distMetersOutside = Math.round(calcHaversine(point2Lat, point2Lng, targetPickupLat, targetPickupLng) * 1000);
    console.log('[P10.4 DIAG] geofence=', JSON.stringify({ distMetersInside, distMetersOutside }));
    assert.ok(distMetersInside <= 300, `Point 1 must be within 300m (was ${distMetersInside}m)`); assert.ok(distMetersOutside > 300, `Point 2 must be outside 300m (was ${distMetersOutside}m)`);
  });

  await suite.test('10.5: Routing Provider Fault Tolerance: Fail-open fallback to vehicle-profile Haversine ETA on API failure', async () => {
    const pickupLat = 17.4400; const pickupLng = 78.3800; const dropLat = 17.4900; const dropLng = 78.3900;
    const syncRoute = routingService.calculatePickupEtaSync(pickupLat, pickupLng, dropLat, dropLng, 'v_ace');
    assert.ok(syncRoute.distKm > 0); assert.ok(syncRoute.pickupEtaMin > 0); assert.equal(syncRoute.source, 'HAVERSINE_PROFILE');
    const simulatedBrokenProvider = { name: 'MockFailingGoogleProvider', async calculateRoute() { throw new Error('Google Maps API 503 Service Unavailable: Rate limit exceeded'); } };
    const resilientEngine = new routingModule.RoutingService({ provider: simulatedBrokenProvider, enableCache: false });
    const fallbackRoute = await resilientEngine.calculateRoute([{ lat: pickupLat, lng: pickupLng }, { lat: dropLat, lng: dropLng }], { vehicleId: 'v_ace', city: 'hyderabad' });
    assert.ok(fallbackRoute); assert.ok(fallbackRoute.distanceKm > 0); assert.ok(fallbackRoute.durationMinutes > 0); assert.equal(fallbackRoute.provider, 'HAVERSINE_FALLBACK'); assert.ok(Array.isArray(fallbackRoute.polyline)); assert.equal(fallbackRoute.polyline.length, 2);
  });
});