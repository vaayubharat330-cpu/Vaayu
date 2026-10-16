'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../src/db/database');
const { DispatchService } = require('../../src/services/dispatchService');
const { DELIVERY_STATES } = require('../../src/services/deliveryStateMachine');

function withTrip(trip, fn) {
  const original = db.getTripById;
  db.getTripById = () => trip;
  return Promise.resolve(fn()).finally(() => { db.getTripById = original; });
}

test('dispatch rejects delayed actions from a previous driver offer', async () => {
  const service = new DispatchService();
  const trip = { id: 'trip-race-1', status: DELIVERY_STATES.DRIVER_ASSIGNED, driver: { id: 'driver-new' } };
  const currentOffer = { driverId: 'driver-new', reservationId: 'reservation-new', offerExpiresAt: Date.now() + 10000 };

  await withTrip(trip, () => {
    assert.equal(service._offerStillOwned('trip-race-1', 'driver-old', currentOffer), false);
    assert.equal(service._offerStillOwned('trip-race-1', 'driver-new', currentOffer), true);
  });
});

test('dispatch rejects an expired offer before state-changing actions', async () => {
  const service = new DispatchService();
  const trip = { id: 'trip-race-2', status: DELIVERY_STATES.DRIVER_ASSIGNED, driver: { id: 'driver-1' } };
  const expiredOffer = { driverId: 'driver-1', reservationId: 'reservation-expired', offerExpiresAt: Date.now() - 1 };

  await withTrip(trip, async () => {
    service.activeOffers.set(trip.id, expiredOffer);
    const result = await service.handleDriverDecline(trip.id, 'driver-1');
    assert.equal(result.success, false);
    assert.equal(result.code, 'DISPATCH_OFFER_STALE');
    assert.ok(service.activeOffers.has(trip.id));
  });
});

test('dispatch timeout callback cannot consume a replacement reservation', async () => {
  const service = new DispatchService();
  const trip = { id: 'trip-race-3', status: DELIVERY_STATES.DRIVER_ASSIGNED, driver: { id: 'driver-new' } };
  const replacementOffer = { driverId: 'driver-new', reservationId: 'replacement-reservation', offerExpiresAt: Date.now() + 10000 };

  await withTrip(trip, async () => {
    service.activeOffers.set(trip.id, replacementOffer);
    const result = await service.handleOfferTimeout(trip.id, 'driver-old', 'old-reservation');
    assert.equal(result.success, false);
    assert.equal(result.code, 'DISPATCH_OFFER_STALE');
    assert.equal(service.activeOffers.get(trip.id).reservationId, 'replacement-reservation');
  });
});
