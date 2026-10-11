const db = require('../db/database');
const { driverLocationService } = require('./driverLocationService');
const { websocketService } = require('./websocketService');
const { calcHaversine } = require('./driverLocationStore');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

/**
 * VAAYU Delivery State Machine & Controlled Order Lifecycle (Milestone 3)
 * 
 * Formal States:
 * - CREATED
 * - SEARCHING_DRIVER
 * - DRIVER_ASSIGNED
 * - DRIVER_ACCEPTED
 * - DRIVER_ARRIVING
 * - DRIVER_AT_PICKUP
 * - PICKUP_CONFIRMED
 * - IN_TRANSIT
 * - DRIVER_AT_DROPOFF
 * - DELIVERED (Terminal)
 * - CANCELLED (Terminal)
 * - FAILED (Terminal)
 */

const DELIVERY_STATES = {
  CREATED: 'CREATED',
  SEARCHING_DRIVER: 'SEARCHING_DRIVER',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_ACCEPTED: 'DRIVER_ACCEPTED',
  DRIVER_ARRIVING: 'DRIVER_ARRIVING',
  DRIVER_AT_PICKUP: 'DRIVER_AT_PICKUP',
  PICKUP_CONFIRMED: 'PICKUP_CONFIRMED',
  IN_TRANSIT: 'IN_TRANSIT',
  DRIVER_AT_DROPOFF: 'DRIVER_AT_DROPOFF',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED'
};

// Formal Transition Matrix (Allowed from -> to)
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
  [DELIVERY_STATES.DELIVERED]: [],
  [DELIVERY_STATES.CANCELLED]: [],
  [DELIVERY_STATES.FAILED]: []
};

// Actor Permission Matrix
const ACTOR_PERMISSIONS = {
  CUSTOMER: {
    allowedTransitions: [
      { from: DELIVERY_STATES.CREATED, to: DELIVERY_STATES.CANCELLED },
      { from: DELIVERY_STATES.SEARCHING_DRIVER, to: DELIVERY_STATES.CANCELLED },
      { from: DELIVERY_STATES.DRIVER_ASSIGNED, to: DELIVERY_STATES.CANCELLED },
      { from: DELIVERY_STATES.DRIVER_ACCEPTED, to: DELIVERY_STATES.CANCELLED }
    ]
  },
  DRIVER: {
    allowedTransitions: [
      { from: DELIVERY_STATES.DRIVER_ASSIGNED, to: DELIVERY_STATES.DRIVER_ACCEPTED },
      { from: DELIVERY_STATES.DRIVER_ASSIGNED, to: DELIVERY_STATES.SEARCHING_DRIVER },
      { from: DELIVERY_STATES.DRIVER_ACCEPTED, to: DELIVERY_STATES.DRIVER_ARRIVING },
      { from: DELIVERY_STATES.DRIVER_ARRIVING, to: DELIVERY_STATES.DRIVER_AT_PICKUP },
      { from: DELIVERY_STATES.DRIVER_AT_PICKUP, to: DELIVERY_STATES.PICKUP_CONFIRMED },
      { from: DELIVERY_STATES.PICKUP_CONFIRMED, to: DELIVERY_STATES.IN_TRANSIT },
      { from: DELIVERY_STATES.IN_TRANSIT, to: DELIVERY_STATES.DRIVER_AT_DROPOFF },
      { from: DELIVERY_STATES.DRIVER_AT_DROPOFF, to: DELIVERY_STATES.DELIVERED },
      { from: DELIVERY_STATES.DRIVER_AT_DROPOFF, to: DELIVERY_STATES.FAILED }
    ]
  },
  SYSTEM: {
    allowedTransitions: [
      { from: DELIVERY_STATES.CREATED, to: DELIVERY_STATES.SEARCHING_DRIVER },
      { from: DELIVERY_STATES.SEARCHING_DRIVER, to: DELIVERY_STATES.DRIVER_ASSIGNED },
      { from: DELIVERY_STATES.DRIVER_ASSIGNED, to: DELIVERY_STATES.SEARCHING_DRIVER },
      { from: DELIVERY_STATES.DRIVER_ACCEPTED, to: DELIVERY_STATES.DRIVER_ARRIVING },
      { from: DELIVERY_STATES.PICKUP_CONFIRMED, to: DELIVERY_STATES.IN_TRANSIT }
    ]
  },
  ADMIN: {
    allowedTransitions: [
      // Admin is authorized for operational override/cancellation across active non-terminal states
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
    ]
  }
};

class DeliveryStateMachine {
  constructor() {
    // Process-level serialized mutex lock map per trip ID
    this.tripLocks = new Map();

    // Idempotency cache: idempotencyKey -> transitionResult
    this.idempotencyCache = new Map();
    this.MAX_IDEMPOTENCY_ENTRIES = 1000;

    // Configurable Geofence Radius (meters)
    this.PICKUP_GEOFENCE_RADIUS_METERS = 300;
    this.DROPOFF_GEOFENCE_RADIUS_METERS = 300;
  }

  /**
   * Serialized Execution Mutex per Trip ID to guarantee process-level atomic transactions
   */
  async withTripLock(tripId, fn) {
    while (this.tripLocks.get(tripId)) {
      await new Promise(r => setTimeout(r, 10)); // Spinlock wait
    }
    this.tripLocks.set(tripId, true);
    try {
      return await fn();
    } finally {
      this.tripLocks.delete(tripId);
    }
  }

  /**
   * Validates if transition is allowed in the transition matrix
   */
  canTransition(currentState, nextState) {
    const allowedNext = TRANSITION_MATRIX[currentState] || [];
    return allowedNext.includes(nextState);
  }

  /**
   * Validates if actor is authorized for transition
   */
  isActorAuthorized(actorType, currentState, nextState) {
    const actorConfig = ACTOR_PERMISSIONS[actorType];
    if (!actorConfig) return false;
    return actorConfig.allowedTransitions.some(t => t.from === currentState && t.to === nextState);
  }

  /**
   * Evaluates geofence proximity between driver location and target location
   */
  async verifyGeofence(driverId, targetLat, targetLng, radiusMeters) {
    const driverState = await driverLocationService.getDriverState(driverId);
    if (!driverState || !driverState.lat || !driverState.lng) {
      return { verified: false, reason: 'Driver location telemetry unavailable' };
    }

    const distanceKm = calcHaversine(driverState.lat, driverState.lng, targetLat, targetLng);
    const distanceMeters = Math.round(distanceKm * 1000);

    if (distanceMeters > radiusMeters) {
      return {
        verified: false,
        reason: `Geofence validation failed: Driver is ${distanceMeters}m away from target (allowed: ${radiusMeters}m)`,
        distanceMeters
      };
    }

    return { verified: true, distanceMeters };
  }

  /**
   * Core State Transition Method
   */
  async transition(tripId, nextState, actor, options = {}) {
    const { idempotencyKey = null, reason = null, otp = null, expectedVersion = null, metadata = {}, proof = null } = options;
    const actorType = (actor && actor.type) ? actor.type : 'SYSTEM';
    const actorId = (actor && actor.id) ? actor.id : 'SYSTEM';

    // 1. Idempotency Check
    if (idempotencyKey && this.idempotencyCache.has(idempotencyKey)) {
      console.log(`[DeliveryStateMachine] Idempotent request served for key: ${idempotencyKey}`);
      return this.idempotencyCache.get(idempotencyKey);
    }

    return await this.withTripLock(tripId, async () => {
      // 2. Fetch Trip Record from Database
      const trip = db.getTripById(tripId);
      if (!trip) {
        return {
          success: false,
          error: { code: 'ORDER_NOT_FOUND', message: `Trip ${tripId} not found` }
        };
      }

      const currentState = trip.status || DELIVERY_STATES.CREATED;

      // 3. Duplicate Transition Check (Idempotent success if already in nextState)
      if (currentState === nextState) {
        const dupResult = { success: true, trip, duplicate: true };
        if (idempotencyKey) this.cacheIdempotency(idempotencyKey, dupResult);
        return dupResult;
      }

      // 4. Terminal State Protection
      if (currentState === DELIVERY_STATES.DELIVERED || currentState === DELIVERY_STATES.CANCELLED || currentState === DELIVERY_STATES.FAILED) {
        return {
          success: false,
          error: { code: 'ORDER_ALREADY_TERMINAL', message: `Order ${tripId} is already in terminal state: ${currentState}` }
        };
      }

      // 5. State Transition Validity
      if (!this.canTransition(currentState, nextState)) {
        return {
          success: false,
          error: { code: 'INVALID_STATE_TRANSITION', message: `Cannot transition order from ${currentState} to ${nextState}` }
        };
      }

      // 6. Actor Authorization Validation
      if (!this.isActorAuthorized(actorType, currentState, nextState)) {
        return {
          success: false,
          error: { code: 'UNAUTHORIZED_TRANSITION', message: `Actor ${actorType} is not authorized for transition ${currentState} -> ${nextState}` }
        };
      }

      // 7. Optimistic Concurrency Control (Version Check)
      const currentVersion = trip.version || 1;
      if (expectedVersion !== null && expectedVersion !== currentVersion) {
        return {
          success: false,
          error: { code: 'CONCURRENCY_CONFLICT', message: `Version conflict: Expected version ${expectedVersion}, found ${currentVersion}` }
        };
      }

      // 8. Specific State Evidence & Geofence Validations
      
      // A. DRIVER_ARRIVING -> DRIVER_AT_PICKUP (Geofence Check)
      if (nextState === DELIVERY_STATES.DRIVER_AT_PICKUP && actorType === 'DRIVER') {
        const driverId = trip.driver ? trip.driver.id : actorId;
        const gf = await this.verifyGeofence(driverId, trip.pickupLat, trip.pickupLng, this.PICKUP_GEOFENCE_RADIUS_METERS);
        if (!gf.verified) {
          return {
            success: false,
            error: { code: 'GEOFENCE_VALIDATION_FAILED', message: gf.reason }
          };
        }
      }

      // B. DRIVER_AT_PICKUP -> PICKUP_CONFIRMED (OTP Verification)
      if (nextState === DELIVERY_STATES.PICKUP_CONFIRMED) {
        // The pickup code is separate from the delivery code. A missing pickup code refuses the step.
        if (!otp || !trip.pickupOtp || String(otp).trim() !== String(trip.pickupOtp).trim()) {
          return {
            success: false,
            error: { code: 'OTP_VERIFICATION_FAILED', message: 'Invalid Goods Pickup Verification OTP' }
          };
        }
      }

      // C. IN_TRANSIT -> DRIVER_AT_DROPOFF (Geofence Check)
      if (nextState === DELIVERY_STATES.DRIVER_AT_DROPOFF && actorType === 'DRIVER') {
        const driverId = trip.driver ? trip.driver.id : actorId;
        const gf = await this.verifyGeofence(driverId, trip.dropLat, trip.dropLng, this.DROPOFF_GEOFENCE_RADIUS_METERS);
        if (!gf.verified) {
          return {
            success: false,
            error: { code: 'GEOFENCE_VALIDATION_FAILED', message: gf.reason }
          };
        }
      }

      // D. DRIVER_AT_DROPOFF -> DELIVERED (OTP Verification)
      if (nextState === DELIVERY_STATES.DELIVERED) {
        if (!otp || String(otp).trim() !== String(trip.deliveryOtp).trim()) {
          return {
            success: false,
            error: { code: 'OTP_VERIFICATION_FAILED', message: 'Invalid Delivery OTP' }
          };
        }
      }

      // 9. Atomic Persistence Update
      const newVersion = currentVersion + 1;
      trip.status = nextState;
      trip.version = newVersion;
      trip.updatedAt = new Date().toISOString();

      if (nextState === DELIVERY_STATES.DELIVERED) {
        trip.completedAt = new Date().toISOString();
        // Proof is stored only here, after the delivery OTP has passed, so it can never attach to an unverified hand-over.
        if (proof) {
          trip.proofOfDelivery = {
            podPhotoUrl: proof.podPhotoUrl || null,
            receiverName: typeof proof.receiverName === 'string' ? proof.receiverName.trim().slice(0, 120) || null : null,
            capturedAt: new Date().toISOString(),
            capturedBy: actorId
          };
        }
      } else if (nextState === DELIVERY_STATES.CANCELLED) {
        trip.cancelledAt = new Date().toISOString();
        trip.cancelReason = reason || 'User requested cancellation';
      }

      db.updateTripStatus(tripId, nextState);
      
      // Update extended trip fields in DB store
      const databaseStore = db.getDb();
      const dbTrip = databaseStore.trips.find(t => t.id === tripId);
      if (dbTrip) {
        dbTrip.version = newVersion;
        dbTrip.updatedAt = trip.updatedAt;
        if (trip.completedAt) dbTrip.completedAt = trip.completedAt;
        if (trip.proofOfDelivery) dbTrip.proofOfDelivery = trip.proofOfDelivery;
        if (trip.cancelledAt) {
          dbTrip.cancelledAt = trip.cancelledAt;
          dbTrip.cancelReason = trip.cancelReason;
        }
        db.saveDb(databaseStore);
      }

      // 10. Audit Log Record Creation
      const auditLogRecord = {
        id: `AUDIT_${Date.now()}_${Math.floor(Math.random()*1000)}`,
        orderId: tripId,
        fromState: currentState,
        toState: nextState,
        actorType,
        actorId,
        version: newVersion,
        idempotencyKey,
        reason: reason || null,
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
        metadata
      };

      if (!databaseStore.delivery_audit_logs) databaseStore.delivery_audit_logs = [];
      databaseStore.delivery_audit_logs.push(auditLogRecord);
      db.saveDb(databaseStore);

      // 11. Real-Time WebSocket Event Emission
      websocketService.broadcastToRoom(`trip:${tripId}`, 'delivery:state_changed', {
        orderId: tripId,
        fromState: currentState,
        toState: nextState,
        actorType,
        version: newVersion,
        timestamp: Date.now()
      });

      const city = (trip.city || 'hyderabad').toLowerCase();
      websocketService.broadcastToRoom(`fleet:${city}`, 'delivery:state_changed', {
        orderId: tripId,
        toState: nextState,
        driverId: trip.driver ? trip.driver.id : null
      });

      metricsService.increment('delivery_transition_total');
      if (nextState === DELIVERY_STATES.CREATED) metricsService.increment('orders_created_total');
      if (nextState === DELIVERY_STATES.DELIVERED) metricsService.increment('orders_completed_total');
      if (nextState === DELIVERY_STATES.CANCELLED) metricsService.increment('orders_cancelled_total');
      if (nextState === DELIVERY_STATES.FAILED) metricsService.increment('orders_failed_total');

      logger.info('delivery_state_transition', `Order ${tripId} transitioned ${currentState} -> ${nextState}`, { orderId: tripId, fromState: currentState, toState: nextState, actorType, version: newVersion, service: 'state_machine' });

      const finalResult = {
        success: true,
        trip: dbTrip || trip,
        auditLog: auditLogRecord
      };

      if (idempotencyKey) {
        this.cacheIdempotency(idempotencyKey, finalResult);
      }

      return finalResult;
    });
  }

  cacheIdempotency(key, result) {
    this.idempotencyCache.set(key, result);
    if (this.idempotencyCache.size > this.MAX_IDEMPOTENCY_ENTRIES) {
      const firstKey = this.idempotencyCache.keys().next().value;
      this.idempotencyCache.delete(firstKey);
    }
  }

  /**
   * Retrieves full audit logs for a trip
   */
  getAuditLogs(tripId) {
    const databaseStore = db.getDb();
    const logs = databaseStore.delivery_audit_logs || [];
    return logs.filter(l => l.orderId === tripId);
  }
}

const deliveryStateMachine = new DeliveryStateMachine();

module.exports = {
  DELIVERY_STATES,
  TRANSITION_MATRIX,
  ACTOR_PERMISSIONS,
  DeliveryStateMachine,
  deliveryStateMachine
};
