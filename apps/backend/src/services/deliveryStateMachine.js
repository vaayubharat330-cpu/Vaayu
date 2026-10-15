const db = require('../db/database');
const { driverLocationService } = require('./driverLocationService');
const { websocketService } = require('./websocketService');
const { calcHaversine } = require('./driverLocationStore');
const { redisLockManager } = require('./redisLockManager');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

const DELIVERY_STATES = {
  CREATED: 'CREATED', SEARCHING_DRIVER: 'SEARCHING_DRIVER', DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_ACCEPTED: 'DRIVER_ACCEPTED', DRIVER_ARRIVING: 'DRIVER_ARRIVING', DRIVER_AT_PICKUP: 'DRIVER_AT_PICKUP',
  PICKUP_CONFIRMED: 'PICKUP_CONFIRMED', IN_TRANSIT: 'IN_TRANSIT', DRIVER_AT_DROPOFF: 'DRIVER_AT_DROPOFF',
  DELIVERED: 'DELIVERED', CANCELLED: 'CANCELLED', FAILED: 'FAILED'
};

const TRANSITION_MATRIX = {
  [DELIVERY_STATES.CREATED]: [DELIVERY_STATES.SEARCHING_DRIVER, DELIVERY_STATES.CANCELLED],
  [DELIVERY_STATES.SEARCHING_DRIVER]: [DELIVERY_STATES.DRIVER_ASSIGNED, DELIVERY_STATES.CANCELLED],
  [DELIVERY_STATES.DRIVER_ASSIGNED]: [DELIVERY_STATES.DRIVER_ACCEPTED, DELIVERY_STATES.SEARCHING_DRIVER, DELIVERY_STATES.CANCELLED],
  [DELIVERY_STATES.DRIVER_ACCEPTED]: [DELIVERY_STATES.DRIVER_ARRIVING, DELIVERY_STATES.CANCELLED],
  [DELIVERY_STATES.DRIVER_ARRIVING]: [DELIVERY_STATES.DRIVER_AT_PICKUP, DELIVERY_STATES.CANCELLED],
  [DELIVERY_STATES.DRIVER_AT_PICKUP]: [DELIVERY_STATES.PICKUP_CONFIRMED, DELIVERY_STATES.CANCELLED],
  [DELIVERY_STATES.PICKUP_CONFIRMED]: [DELIVERY_STATES.IN_TRANSIT, DELIVERY_STATES.CANCELLED],
  [DELIVERY_STATES.IN_TRANSIT]: [DELIVERY_STATES.DRIVER_AT_DROPOFF, DELIVERY_STATES.CANCELLED],
  [DELIVERY_STATES.DRIVER_AT_DROPOFF]: [DELIVERY_STATES.DELIVERED, DELIVERY_STATES.FAILED, DELIVERY_STATES.CANCELLED],
  [DELIVERY_STATES.DELIVERED]: [], [DELIVERY_STATES.CANCELLED]: [], [DELIVERY_STATES.FAILED]: []
};

const ACTOR_PERMISSIONS = {
  CUSTOMER: { allowedTransitions: [
    { from: DELIVERY_STATES.CREATED, to: DELIVERY_STATES.CANCELLED },
    { from: DELIVERY_STATES.SEARCHING_DRIVER, to: DELIVERY_STATES.CANCELLED },
    { from: DELIVERY_STATES.DRIVER_ASSIGNED, to: DELIVERY_STATES.CANCELLED },
    { from: DELIVERY_STATES.DRIVER_ACCEPTED, to: DELIVERY_STATES.CANCELLED }
  ]},
  DRIVER: { allowedTransitions: [
    { from: DELIVERY_STATES.DRIVER_ASSIGNED, to: DELIVERY_STATES.DRIVER_ACCEPTED },
    { from: DELIVERY_STATES.DRIVER_ASSIGNED, to: DELIVERY_STATES.SEARCHING_DRIVER },
    { from: DELIVERY_STATES.DRIVER_ACCEPTED, to: DELIVERY_STATES.DRIVER_ARRIVING },
    { from: DELIVERY_STATES.DRIVER_ARRIVING, to: DELIVERY_STATES.DRIVER_AT_PICKUP },
    { from: DELIVERY_STATES.DRIVER_AT_PICKUP, to: DELIVERY_STATES.PICKUP_CONFIRMED },
    { from: DELIVERY_STATES.PICKUP_CONFIRMED, to: DELIVERY_STATES.IN_TRANSIT },
    { from: DELIVERY_STATES.IN_TRANSIT, to: DELIVERY_STATES.DRIVER_AT_DROPOFF },
    { from: DELIVERY_STATES.DRIVER_AT_DROPOFF, to: DELIVERY_STATES.DELIVERED },
    { from: DELIVERY_STATES.DRIVER_AT_DROPOFF, to: DELIVERY_STATES.FAILED }
  ]},
  SYSTEM: { allowedTransitions: [
    { from: DELIVERY_STATES.CREATED, to: DELIVERY_STATES.SEARCHING_DRIVER },
    { from: DELIVERY_STATES.SEARCHING_DRIVER, to: DELIVERY_STATES.DRIVER_ASSIGNED },
    { from: DELIVERY_STATES.DRIVER_ASSIGNED, to: DELIVERY_STATES.SEARCHING_DRIVER },
    { from: DELIVERY_STATES.DRIVER_ACCEPTED, to: DELIVERY_STATES.DRIVER_ARRIVING },
    { from: DELIVERY_STATES.PICKUP_CONFIRMED, to: DELIVERY_STATES.IN_TRANSIT }
  ]},
  ADMIN: { allowedTransitions: [
    { from: DELIVERY_STATES.CREATED, to: DELIVERY_STATES.CANCELLED },
    { from: DELIVERY_STATES.SEARCHING_DRIVER, to: DELIVERY_STATES.CANCELLED },
    { from: DELIVERY_STATES.DRIVER_ASSIGNED, to: DELIVERY_STATES.CANCELLED },
    { from: DELIVERY_STATES.DRIVER_ACCEPTED, to: DELIVERY_STATES.CANCELLED },
    { from: DELIVERY_STATES.DRIVER_ARRIVING, to: DELIVERY_STATES.CANCELLED },
    { from: DELIVERY_STATES.DRIVER_AT_PICKUP, to: DELIVERY_STATES.CANCELLED },
    { from: DELIVERY_STATES.PICKUP_CONFIRMED, to: DELIVERY_STATES.CANCELLED },
    { from: DELIVERY_STATES.IN_TRANSIT, to: DELIVERY_STATES.CANCELLED },
    { from: DELIVERY_STATES.DRIVER_AT_DROPOFF, to: DELIVERY_STATES.CANCELLED },
    { from: DELIVERY_STATES.DRIVER_AT_DROPOFF, to: DELIVERY_STATES.FAILED }
  ]}
};

class DeliveryStateMachine {
  constructor() {
    this.tripLocks = new Map();
    this.idempotencyCache = new Map();
    this.MAX_IDEMPOTENCY_ENTRIES = 1000;
    this.PICKUP_GEOFENCE_RADIUS_METERS = 300;
    this.DROPOFF_GEOFENCE_RADIUS_METERS = 300;
  }

  async withTripLock(tripId, fn) {
    while (this.tripLocks.get(tripId)) await new Promise(r => setTimeout(r, 10));
    this.tripLocks.set(tripId, true);
    const distributedLock = await redisLockManager.acquireTripLock(tripId, 30000);
    if (!distributedLock.success) {
      this.tripLocks.delete(tripId);
      return { success: false, error: { code: 'TRIP_COMMAND_CONFLICT', message: 'Another backend instance is already processing this trip. Retry the command.' } };
    }
    try { return await fn(); }
    finally {
      await redisLockManager.releaseTripLock(distributedLock).catch(() => {});
      this.tripLocks.delete(tripId);
    }
  }

  canTransition(currentState, nextState) { return (TRANSITION_MATRIX[currentState] || []).includes(nextState); }
  isActorAuthorized(actorType, currentState, nextState) {
    const actorConfig = ACTOR_PERMISSIONS[actorType];
    return Boolean(actorConfig && actorConfig.allowedTransitions.some(t => t.from === currentState && t.to === nextState));
  }

  async verifyGeofence(driverId, targetLat, targetLng, radiusMeters) {
    const driverState = await driverLocationService.getDriverState(driverId);
    if (!driverState || !driverState.lat || !driverState.lng) return { verified: false, reason: 'Driver location telemetry unavailable' };
    const distanceMeters = Math.round(calcHaversine(driverState.lat, driverState.lng, targetLat, targetLng) * 1000);
    if (distanceMeters > radiusMeters) return { verified: false, reason: `Geofence validation failed: Driver is ${distanceMeters}m away from target (allowed: ${radiusMeters}m)`, distanceMeters };
    return { verified: true, distanceMeters };
  }

  async transition(tripId, nextState, actor, options = {}) {
    const { idempotencyKey = null, reason = null, otp = null, expectedVersion = null, metadata = {}, proof = null } = options;
    const actorType = actor?.type || 'SYSTEM';
    const actorId = actor?.id || 'SYSTEM';
    if (idempotencyKey && this.idempotencyCache.has(idempotencyKey)) return this.idempotencyCache.get(idempotencyKey);

    return this.withTripLock(tripId, async () => {
      const trip = db.getTripById(tripId);
      if (!trip) return { success: false, error: { code: 'ORDER_NOT_FOUND', message: `Trip ${tripId} not found` } };
      const currentState = trip.status || DELIVERY_STATES.CREATED;
      if (currentState === nextState) {
        const dupResult = { success: true, trip, duplicate: true };
        if (idempotencyKey) this.cacheIdempotency(idempotencyKey, dupResult);
        return dupResult;
      }
      if ([DELIVERY_STATES.DELIVERED, DELIVERY_STATES.CANCELLED, DELIVERY_STATES.FAILED].includes(currentState)) return { success: false, error: { code: 'ORDER_ALREADY_TERMINAL', message: `Order ${tripId} is already in terminal state: ${currentState}` } };
      if (!this.canTransition(currentState, nextState)) return { success: false, error: { code: 'INVALID_STATE_TRANSITION', message: `Cannot transition order from ${currentState} to ${nextState}` } };
      if (!this.isActorAuthorized(actorType, currentState, nextState)) return { success: false, error: { code: 'UNAUTHORIZED_TRANSITION', message: `Actor ${actorType} is not authorized for transition ${currentState} -> ${nextState}` } };
      const currentVersion = trip.version || 1;
      if (expectedVersion !== null && expectedVersion !== currentVersion) return { success: false, error: { code: 'CONCURRENCY_CONFLICT', message: `Version conflict: Expected version ${expectedVersion}, found ${currentVersion}` } };

      if (nextState === DELIVERY_STATES.DRIVER_AT_PICKUP && actorType === 'DRIVER') {
        const gf = await this.verifyGeofence(trip.driver?.id || actorId, trip.pickupLat, trip.pickupLng, this.PICKUP_GEOFENCE_RADIUS_METERS);
        if (!gf.verified) return { success: false, error: { code: 'GEOFENCE_VALIDATION_FAILED', message: gf.reason } };
      }
      if (nextState === DELIVERY_STATES.PICKUP_CONFIRMED && (!otp || !trip.pickupOtp || String(otp).trim() !== String(trip.pickupOtp).trim())) return { success: false, error: { code: 'OTP_VERIFICATION_FAILED', message: 'Invalid Goods Pickup Verification OTP' } };
      if (nextState === DELIVERY_STATES.DRIVER_AT_DROPOFF && actorType === 'DRIVER') {
        const gf = await this.verifyGeofence(trip.driver?.id || actorId, trip.dropLat, trip.dropLng, this.DROPOFF_GEOFENCE_RADIUS_METERS);
        if (!gf.verified) return { success: false, error: { code: 'GEOFENCE_VALIDATION_FAILED', message: gf.reason } };
      }
      if (nextState === DELIVERY_STATES.DELIVERED && (!otp || String(otp).trim() !== String(trip.deliveryOtp).trim())) return { success: false, error: { code: 'OTP_VERIFICATION_FAILED', message: 'Invalid Delivery OTP' } };

      const newVersion = currentVersion + 1;
      const updatedAt = new Date().toISOString();
      trip.status = nextState;
      trip.version = newVersion;
      trip.updatedAt = updatedAt;

      if (nextState === DELIVERY_STATES.DRIVER_ASSIGNED && metadata.assignedDriver) {
        const d = metadata.assignedDriver;
        trip.driver = {
          id: d.driverId || d.id || d.userId,
          name: d.driverName || d.name || null,
          phone: d.phone || null,
          vehicleNumber: d.vehicleNumber || null,
          rating: Number(d.rating || 4.9),
          currentLat: d.lat ?? null,
          currentLng: d.lng ?? null
        };
        trip.driverReservationId = metadata.reservationId || null;
        trip.offerExpiresAt = metadata.offerExpiresAt || null;
      }

      if (nextState === DELIVERY_STATES.DELIVERED) {
        trip.completedAt = updatedAt;
        if (proof) trip.proofOfDelivery = { podPhotoUrl: proof.podPhotoUrl || null, receiverName: typeof proof.receiverName === 'string' ? proof.receiverName.trim().slice(0, 120) || null : null, capturedAt: updatedAt, capturedBy: actorId };
      } else if (nextState === DELIVERY_STATES.CANCELLED) {
        trip.cancelledAt = updatedAt;
        trip.cancelReason = reason || 'User requested cancellation';
      }

      const databaseStore = db.getDb();
      const dbTrip = databaseStore.trips.find(t => t.id === tripId);
      if (!dbTrip) return { success: false, error: { code: 'TRIP_NOT_FOUND', message: `Trip ${tripId} disappeared during transition` } };
      Object.assign(dbTrip, trip);

      const auditLogRecord = {
        id: `AUDIT_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        orderId: tripId, fromState: currentState, toState: nextState,
        actorType, actorId, version: newVersion, idempotencyKey,
        reason: reason || null, timestamp: Date.now(), isoTime: updatedAt, metadata
      };
      if (!databaseStore.delivery_audit_logs) databaseStore.delivery_audit_logs = [];
      databaseStore.delivery_audit_logs.push(auditLogRecord);
      db.saveDb(databaseStore);

      try { await db.waitForCommit(); }
      catch (error) {
        logger.error('delivery_transition_persistence_failed', `Order ${tripId} transition was not durably committed`, { orderId: tripId, fromState: currentState, toState: nextState, version: newVersion, error: error.message });
        return { success: false, error: { code: 'PERSISTENCE_COMMIT_FAILED', message: 'Delivery state transition could not be durably committed. Retry the same command.' } };
      }

      await websocketService.broadcastToRoom(`trip:${tripId}`, 'delivery:state_changed', { orderId: tripId, fromState: currentState, toState: nextState, actorType, version: newVersion, timestamp: Date.now() });
      const city = (trip.city || 'hyderabad').toLowerCase();
      await websocketService.broadcastToRoom(`fleet:${city}`, 'delivery:state_changed', { orderId: tripId, toState: nextState, driverId: trip.driver ? trip.driver.id : null });

      metricsService.increment('delivery_transition_total');
      if (nextState === DELIVERY_STATES.CREATED) metricsService.increment('orders_created_total');
      if (nextState === DELIVERY_STATES.DELIVERED) metricsService.increment('orders_completed_total');
      if (nextState === DELIVERY_STATES.CANCELLED) metricsService.increment('orders_cancelled_total');
      if (nextState === DELIVERY_STATES.FAILED) metricsService.increment('orders_failed_total');
      logger.info('delivery_state_transition', `Order ${tripId} transitioned ${currentState} -> ${nextState}`, { orderId: tripId, fromState: currentState, toState: nextState, actorType, version: newVersion, service: 'state_machine' });

      const responseTrip = { ...dbTrip };
      delete responseTrip.deliveryOtp;
      const finalResult = { success: true, trip: responseTrip, auditLog: auditLogRecord };
      if (idempotencyKey) this.cacheIdempotency(idempotencyKey, finalResult);
      return finalResult;
    });
  }

  cacheIdempotency(key, result) {
    this.idempotencyCache.set(key, result);
    if (this.idempotencyCache.size > this.MAX_IDEMPOTENCY_ENTRIES) this.idempotencyCache.delete(this.idempotencyCache.keys().next().value);
  }
  getAuditLogs(tripId) {
    const logs = db.getDb().delivery_audit_logs || [];
    return logs.filter(l => l.orderId === tripId);
  }
}

const deliveryStateMachine = new DeliveryStateMachine();
module.exports = { DELIVERY_STATES, TRANSITION_MATRIX, ACTOR_PERMISSIONS, DeliveryStateMachine, deliveryStateMachine };
