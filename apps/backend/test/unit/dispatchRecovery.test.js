'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../src/db/database');
const { DispatchRecoveryService } = require('../../src/services/dispatchRecoveryService');
const { dispatchService } = require('../../src/services/dispatchService');
const { deliveryStateMachine, DELIVERY_STATES } = require('../../src/services/deliveryStateMachine');
const { redisLockManager } = require('../../src/services/redisLockManager');

test('dispatch recovery rehydrates a live persisted offer after process restart', async () => {
  const original = {
    getTripById: db.getTripById,
    getTrips: db.getTrips,
    acquireScopedLock: redisLockManager.acquireScopedLock,
    releaseScopedLock: redisLockManager.releaseScopedLock,
    getDriverLock: redisLockManager.getDriverLock,
    addDeclinedDriver: redisLockManager.addDeclinedDriver,
    releaseDriverLock: redisLockManager.releaseDriverLock
  };

  const orderId = `RECOVER_LIVE_${Date.now()}`;
  const trip = {
    id: orderId,
    status: DELIVERY_STATES.DRIVER_ASSIGNED,
    driver: { id: 'drv_recover_live' },
    driverReservationId: 'res_recover_live',
    offerExpiresAt: Date.now() + 60_000
  };

  try {
    dispatchService.activeOffers.delete(orderId);
    db.getTrips = () => [trip];
    db.getTripById = id => id === orderId ? trip : null;
    redisLockManager.acquireScopedLock = async () => ({ success: true, key: 'recovery', token: 'token' });
    redisLockManager.releaseScopedLock = async () => true;
    redisLockManager.getDriverLock = async () => ({
      orderId,
      driverId: 'drv_recover_live',
      reservationId: 'res_recover_live',
      expiresAt: Date.now() + 60_000
    });

    const result = await new DispatchRecoveryService().recoverPersistedOffers();

    assert.equal(result.recovered, 1);
    assert.equal(dispatchService.activeOffers.get(orderId).driverId, 'drv_recover_live');
    assert.equal(dispatchService.activeOffers.get(orderId).reservationId, 'res_recover_live');
  } finally {
    const offer = dispatchService.activeOffers.get(orderId);
    if (offer?.timerId) clearTimeout(offer.timerId);
    dispatchService.activeOffers.delete(orderId);
    Object.assign(db, { getTripById: original.getTripById, getTrips: original.getTrips });
    Object.assign(redisLockManager, {
      acquireScopedLock: original.acquireScopedLock,
      releaseScopedLock: original.releaseScopedLock,
      getDriverLock: original.getDriverLock,
      addDeclinedDriver: original.addDeclinedDriver,
      releaseDriverLock: original.releaseDriverLock
    });
  }
});

test('dispatch recovery releases an expired reservation and redispatches the trip', async () => {
  const original = {
    getTrips: db.getTrips,
    getTripById: db.getTripById,
    acquireScopedLock: redisLockManager.acquireScopedLock,
    releaseScopedLock: redisLockManager.releaseScopedLock,
    getDriverLock: redisLockManager.getDriverLock,
    releaseDriverLock: redisLockManager.releaseDriverLock,
    addDeclinedDriver: redisLockManager.addDeclinedDriver,
    transition: deliveryStateMachine.transition,
    findAndOfferDriver: dispatchService.findAndOfferDriver
  };

  const orderId = `RECOVER_EXPIRED_${Date.now()}`;
  const trip = {
    id: orderId,
    status: DELIVERY_STATES.DRIVER_ASSIGNED,
    driver: { id: 'drv_recover_expired' },
    driverReservationId: 'res_recover_expired',
    offerExpiresAt: Date.now() - 1
  };
  let releasedReservation = null;
  let redispatchCalled = false;
  let transitionCalled = false;

  try {
    db.getTrips = () => [trip];
    db.getTripById = id => id === orderId ? trip : null;
    redisLockManager.acquireScopedLock = async () => ({ success: true, key: 'recovery', token: 'token' });
    redisLockManager.releaseScopedLock = async () => true;
    redisLockManager.getDriverLock = async () => ({
      orderId,
      driverId: 'drv_recover_expired',
      reservationId: 'res_recover_expired',
      expiresAt: Date.now() - 1
    });
    redisLockManager.releaseDriverLock = async (driverId, reservationId) => {
      releasedReservation = { driverId, reservationId };
      return true;
    };
    redisLockManager.addDeclinedDriver = async () => {};
    deliveryStateMachine.transition = async () => {
      transitionCalled = true;
      trip.status = DELIVERY_STATES.SEARCHING_DRIVER;
      return { success: true };
    };
    dispatchService.findAndOfferDriver = async id => {
      redispatchCalled = id === orderId;
      return { success: true };
    };

    const result = await new DispatchRecoveryService().recoverPersistedOffers();

    assert.equal(result.expired, 1);
    assert.deepEqual(releasedReservation, {
      driverId: 'drv_recover_expired',
      reservationId: 'res_recover_expired'
    });
    assert.equal(transitionCalled, true);
    assert.equal(redispatchCalled, true);
  } finally {
    Object.assign(db, { getTripById: original.getTripById, getTrips: original.getTrips });
    Object.assign(redisLockManager, {
      acquireScopedLock: original.acquireScopedLock,
      releaseScopedLock: original.releaseScopedLock,
      getDriverLock: original.getDriverLock,
      releaseDriverLock: original.releaseDriverLock,
      addDeclinedDriver: original.addDeclinedDriver
    });
    deliveryStateMachine.transition = original.transition;
    dispatchService.findAndOfferDriver = original.findAndOfferDriver;
  }
});

test('dispatch recovery uses a distributed recovery lock so only one instance reconciles an offer', async () => {
  let lockAcquired = false;
  const original = {
    getTrips: db.getTrips,
    acquireScopedLock: redisLockManager.acquireScopedLock,
    releaseScopedLock: redisLockManager.releaseScopedLock
  };
  const trip = {
    id: `RECOVER_RACE_${Date.now()}`,
    status: DELIVERY_STATES.DRIVER_ASSIGNED,
    driver: { id: 'drv_recover_race' },
    driverReservationId: 'res_recover_race',
    offerExpiresAt: Date.now() + 60_000
  };

  try {
    db.getTrips = () => [trip];
    redisLockManager.acquireScopedLock = async () => {
      if (lockAcquired) return { success: false };
      lockAcquired = true;
      return { success: true, key: 'recovery', token: 'token' };
    };
    redisLockManager.releaseScopedLock = async () => true;

    const [first, second] = await Promise.all([
      new DispatchRecoveryService().reconcileOffer(trip.id),
      new DispatchRecoveryService().reconcileOffer(trip.id)
    ]);

    assert.equal(first, 'ignored');
    assert.equal(second, 'busy');
  } finally {
    Object.assign(db, { getTrips: original.getTrips });
    Object.assign(redisLockManager, {
      acquireScopedLock: original.acquireScopedLock,
      releaseScopedLock: original.releaseScopedLock
    });
  }
});
