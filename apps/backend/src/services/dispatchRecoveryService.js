'use strict';

const db = require('../db/database');
const { dispatchService } = require('./dispatchService');
const { DELIVERY_STATES, deliveryStateMachine } = require('./deliveryStateMachine');
const { redisLockManager } = require('./redisLockManager');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

/**
 * Restart-safe reconciliation for persisted DRIVER_ASSIGNED offers.
 *
 * Dispatch timers are intentionally process-local, while the authoritative offer
 * ownership (driverReservationId + offerExpiresAt) is persisted on the trip and
 * the driver reservation lives in Redis. On process restart we reconstruct the
 * timer from that durable state instead of assuming an in-memory Map survived.
 */
class DispatchRecoveryService {
  constructor() {
    this.RECOVERY_LOCK_PREFIX = 'dispatch:recovery:';
    this.RECOVERY_LOCK_TTL_MS = 10000;
    this.recoveryInFlight = new Set();
  }

  async recoverPersistedOffers() {
    const trips = typeof db.getTrips === 'function' ? (db.getTrips() || []) : [];
    const assignedTrips = trips.filter(trip => trip && trip.status === DELIVERY_STATES.DRIVER_ASSIGNED && trip.offerExpiresAt);

    let recovered = 0;
    let expired = 0;
    for (const trip of assignedTrips) {
      try {
        const result = await this.reconcileOffer(trip.id);
        if (result === 'rehydrated') recovered += 1;
        if (result === 'expired') expired += 1;
      } catch (error) {
        logger.error('dispatch_recovery_failed', `Failed to reconcile persisted offer ${trip.id}`, {
          orderId: trip.id,
          error: error.message,
          service: 'dispatch-recovery'
        });
        metricsService.increment('dispatch_recovery_error_total');
      }
    }

    metricsService.increment('dispatch_recovery_runs_total');
    if (recovered) metricsService.increment('dispatch_recovery_rehydrated_total', recovered);
    if (expired) metricsService.increment('dispatch_recovery_expired_total', expired);

    return { scanned: assignedTrips.length, recovered, expired };
  }

  async reconcileOffer(orderId) {
    if (this.recoveryInFlight.has(orderId)) return 'busy';

    const lock = await redisLockManager.acquireScopedLock(
      this.RECOVERY_LOCK_PREFIX,
      orderId,
      this.RECOVERY_LOCK_TTL_MS
    );
    if (!lock.success) return 'busy';

    this.recoveryInFlight.add(orderId);
    try {
      const trip = db.getTripById(orderId);
      if (!trip || trip.status !== DELIVERY_STATES.DRIVER_ASSIGNED) return 'ignored';

      const driverId = trip.driver?.id || trip.driver?.userId;
      const reservationId = trip.driverReservationId;
      const offerExpiresAt = Number(trip.offerExpiresAt);
      if (!driverId || !Number.isFinite(offerExpiresAt)) return 'ignored';

      const driverLock = await redisLockManager.getDriverLock(driverId);
      const ownsPersistedReservation = Boolean(
        driverLock &&
        driverLock.orderId === orderId &&
        (!reservationId || driverLock.reservationId === reservationId)
      );

      if (offerExpiresAt > Date.now() && ownsPersistedReservation) {
        this.scheduleRecoveredOffer(trip, driverLock);
        return 'rehydrated';
      }

      // The persisted offer is no longer safely live. Release only the reservation
      // belonging to this trip, then move the authoritative state back to search.
      if (driverLock && driverLock.orderId === orderId) {
        await redisLockManager.releaseDriverLock(driverId, driverLock.reservationId);
      } else if (reservationId) {
        await redisLockManager.releaseDriverLock(driverId, reservationId);
      }

      await redisLockManager.addDeclinedDriver(orderId, driverId);
      await this.markDriverDeclined(orderId, driverId);
      return 'expired';
    } finally {
      this.recoveryInFlight.delete(orderId);
      await redisLockManager.releaseScopedLock(lock);
    }
  }

  scheduleRecoveredOffer(trip, driverLock) {
    const orderId = trip.id;
    if (dispatchService.activeOffers.has(orderId)) return;

    const remainingMs = Math.max(0, Number(trip.offerExpiresAt) - Date.now());
    const timerId = setTimeout(async () => {
      const timeoutLock = await redisLockManager.acquireScopedLock(
        this.RECOVERY_LOCK_PREFIX,
        orderId,
        this.RECOVERY_LOCK_TTL_MS
      );
      if (!timeoutLock.success) return;

      try {
        const currentTrip = db.getTripById(orderId);
        if (!currentTrip || currentTrip.status !== DELIVERY_STATES.DRIVER_ASSIGNED) return;

        const currentDriverId = currentTrip.driver?.id || currentTrip.driver?.userId;
        const currentReservationId = currentTrip.driverReservationId;
        const currentLock = await redisLockManager.getDriverLock(currentDriverId);
        if (!currentLock || currentLock.orderId !== orderId || (currentReservationId && currentLock.reservationId !== currentReservationId)) return;

        metricsService.increment('dispatch_offer_timeout_total');
        await dispatchService.handleOfferTimeout(orderId, currentDriverId);
      } finally {
        await redisLockManager.releaseScopedLock(timeoutLock);
      }
    }, remainingMs);

    dispatchService.activeOffers.set(orderId, {
      driverId: driverLock.driverId,
      reservationId: driverLock.reservationId,
      offerExpiresAt: Number(trip.offerExpiresAt),
      timerId,
      recovered: true
    });

    logger.info('dispatch_offer_rehydrated', `Rehydrated persisted dispatch offer for ${orderId}`, {
      orderId,
      driverId: driverLock.driverId,
      reservationId: driverLock.reservationId,
      offerExpiresAt: Number(trip.offerExpiresAt),
      service: 'dispatch-recovery'
    });
  }

  async markDriverDeclined(orderId, driverId) {
    const transition = await deliveryStateMachine.transition(
      orderId,
      DELIVERY_STATES.SEARCHING_DRIVER,
      { type: 'SYSTEM', id: 'DISPATCH_RECOVERY' },
      { reason: `Persisted driver offer expired or lost during backend restart for driver ${driverId}` }
    );
    if (!transition.success) return transition;

    return dispatchService.findAndOfferDriver(orderId);
  }
}

const dispatchRecoveryService = new DispatchRecoveryService();

module.exports = { DispatchRecoveryService, dispatchRecoveryService };
