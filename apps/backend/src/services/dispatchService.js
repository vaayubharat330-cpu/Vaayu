const db = require('../db/database');
const { driverLocationService } = require('./driverLocationService');
const { deliveryStateMachine, DELIVERY_STATES } = require('./deliveryStateMachine');
const { websocketService } = require('./websocketService');
const { calcHaversine } = require('./driverLocationStore');
const { routingService } = require('./routingService');
const { redisLockManager } = require('./redisLockManager');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

/**
 * VAAYU Milestone 4 & Milestone 6 Phase 6.3: Deterministic Dispatch Engine & Distributed Lock Manager
 * 
 * Objectives:
 * 1. Filter eligible drivers based on liveness (ONLINE/DEGRADED), availability (not busy on active trip), vehicle fit, and Redis driver locks.
 * 2. Evaluate candidates using a transparent, explainable deterministic scoring function (Distance + ETA + Capacity + Rating - Workload Penalty).
 * 3. Atomic 30-second driver offer reservation lock backed by Redis SET NX PX.
 * 4. Automatic fallback re-dispatch to next-best candidate on driver decline or offer timeout.
 * 5. Cluster-wide decline tracking via Redis Sets.
 */

class DispatchService {
  constructor() {
    // Offer Reservations: orderId -> { driverId, offerExpiresAt, timerId }
    this.activeOffers = new Map();

    // Order Declined Driver Sets: orderId -> Set<driverId>
    this.declinedDrivers = new Map();

    // Configurable Offer Duration (30 seconds)
    this.OFFER_TIMEOUT_MS = 30000;

    // Dispatch Scoring Weights
    this.WEIGHTS = {
      DISTANCE: 1.5,
      ETA: 1.0,
      RATING: 8.0,
      CAPACITY_FIT: 15.0,
      WORKLOAD_PENALTY: 3.0
    };
  }

  getActiveOffersForDriver(driverId) {
    const offers = [];
    for (const [orderId, offer] of this.activeOffers.entries()) {
      if (String(offer.driverId) !== String(driverId)) continue;
      const trip = db.getTripById(orderId);
      if (!trip || trip.status !== DELIVERY_STATES.DRIVER_ASSIGNED) continue;
      offers.push({
        tripId: trip.id,
        orderId: trip.id,
        driverId: offer.driverId,
        pickupAddress: trip.pickupAddress,
        pickupLat: trip.pickupLat,
        pickupLng: trip.pickupLng,
        dropAddress: trip.dropAddress,
        dropLat: trip.dropLat,
        dropLng: trip.dropLng,
        vehicleName: trip.vehicleName,
        distanceKm: trip.distanceKm,
        estimatedEarnings: trip.totalFare,
        customerName: trip.customerName,
        customerPhone: trip.customerPhone,
        isCod: Boolean(trip.isCod || trip.paymentInfo?.method === 'CASH_ON_DELIVERY'),
        codAmount: trip.isCod ? Number(trip.totalFare || 0) : 0,
        offerExpiresAt: offer.offerExpiresAt
      });
    }
    return offers;
  }

  async handleDriverAccept(orderId, driverId) {
    const trip = db.getTripById(orderId);
    const assignedDriverId = trip?.driver?.id || trip?.driver?.userId;
    if (!trip || String(assignedDriverId) !== String(driverId)) {
      return { success: false, error: 'This offer is not assigned to the driver.' };
    }
    const offer = this.activeOffers.get(orderId);
    if (offer && String(offer.driverId) !== String(driverId)) {
      return { success: false, error: 'The active offer belongs to a different driver.' };
    }
    const reservationId = offer?.reservationId || orderId;
    if (offer) await this.clearExistingOffer(orderId);
    else await redisLockManager.releaseDriverLock(driverId, reservationId);
    return { success: true };
  }

  /**
   * Transparent Deterministic Scoring Function
   */
  scoreCandidate(driver, order, pickupLat, pickupLng) {
    const pickupEtaObj = routingService.calculatePickupEtaSync(driver.lat, driver.lng, pickupLat, pickupLng, driver.vehicleId || order.vehicleId);
    const distKm = pickupEtaObj.distKm;
    const etaMin = pickupEtaObj.pickupEtaMin;

    // 1. Distance Component (max 100 points, decreases with distance)
    const distanceScore = Math.max(0, 100 - (distKm * 8)) * this.WEIGHTS.DISTANCE;

    // 2. ETA Component (max 60 points, decreases with drive time)
    const etaScore = Math.max(0, 60 - (etaMin * 2)) * this.WEIGHTS.ETA;

    // 3. Driver Rating Component (e.g., 4.9 rating = 39.2 points)
    const rating = parseFloat(driver.rating) || 4.5;
    const ratingScore = rating * this.WEIGHTS.RATING;

    // 4. Vehicle Capacity Match Bonus
    const capacityScore = (driver.vehicleId === order.vehicleId) ? this.WEIGHTS.CAPACITY_FIT : 0;

    // 5. Workload Fairness Penalty (penalty for drivers with high trip count today, max 10 trips penalty)
    const todayTrips = parseInt(driver.todayTrips || driver.todayTripsCount || 0, 10);
    const workloadPenalty = Math.min(30, todayTrips * this.WEIGHTS.WORKLOAD_PENALTY);

    // Final Deterministic Score
    const totalScore = Math.max(0, Math.round(distanceScore + etaScore + ratingScore + capacityScore - workloadPenalty));


    return {
      driverId: driver.driverId || driver.id || driver.userId,
      driverName: driver.name,
      phone: driver.phone,
      vehicleId: driver.vehicleId,
      vehicleNumber: driver.vehicleNumber,
      lat: driver.lat,
      lng: driver.lng,
      distKm: Math.round(distKm * 100) / 100,
      etaMin,
      totalScore,
      scoreBreakdown: {
        distanceScore: Math.round(distanceScore),
        etaScore: Math.round(etaScore),
        ratingScore: Math.round(ratingScore),
        capacityScore: Math.round(capacityScore),
        workloadPenalty: Math.round(workloadPenalty)
      }
    };
  }

  /**
   * Pipeline to discover and filter eligible driver candidates for an order
   */
  async getCandidateDrivers(order) {
    const pickupLat = parseFloat(order.pickupLat);
    const pickupLng = parseFloat(order.pickupLng);
    const requiredVehicleId = order.vehicleId;

    // Fetch declined driver sets from local cache and shared Redis cluster storage
    const redisDeclined = await redisLockManager.getDeclinedDrivers(order.id);
    const localDeclined = this.declinedDrivers.get(order.id) || new Set();
    const declinedSet = new Set([...localDeclined, ...redisDeclined]);

    const dbDrivers = db.getDrivers() || [];
    const now = Date.now();
    const activeTrips = (db.getTrips() || []).filter(t => {
      if (t.status === 'DELIVERED' || t.status === 'CANCELLED' || t.status === 'FAILED' || t.status === 'CREATED' || t.status === 'SEARCHING_DRIVER') return false;
      const tripAgeMs = t.createdAt ? (now - new Date(t.createdAt).getTime()) : 0;
      return tripAgeMs < 1800000; // 30 mins
    });
    const busyDriverIds = new Set(activeTrips.filter(t => t.id !== order.id && t.driver).map(t => (t.driver.id || t.driver.userId)));

    const candidates = [];

    for (const dProf of dbDrivers) {
      const driverId = dProf.id || dProf.userId;

      // Filter 1: Skip drivers who declined this specific order
      if (declinedSet.has(driverId)) continue;

      // Filter 2: Skip drivers already busy on another active trip
      if (busyDriverIds.has(driverId)) continue;

      // Filter 3: Check distributed driver reservation lock in Redis
      const existingLock = await redisLockManager.getDriverLock(driverId);
      if (existingLock && existingLock.orderId !== order.id) {
        // Driver is currently locked / reserved by a competing offer on another backend node
        continue;
      }

      // Filter 4: Check driver liveness in driverLocationService
      const telemetry = await driverLocationService.getDriverState(driverId);
      const lat = (telemetry && telemetry.lat) ? telemetry.lat : dProf.currentLat;
      const lng = (telemetry && telemetry.lng) ? telemetry.lng : dProf.currentLng;
      const liveness = (telemetry && telemetry.livenessState) ? telemetry.livenessState : 'ONLINE';
      const status = (telemetry && telemetry.status) ? telemetry.status : dProf.status;

      // A driver with no usable position cannot be scored or dispatched.
      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) continue;

      // Reject STALE or OFFLINE drivers
      if (liveness === 'STALE' || liveness === 'OFFLINE' || status === 'OFFLINE') continue;

      // Filter 5: Vehicle category match
      if (requiredVehicleId && dProf.vehicleId !== requiredVehicleId) continue;

      const fullDriverObj = {
        driverId,
        name: dProf.name,
        phone: dProf.phone,
        vehicleId: dProf.vehicleId,
        vehicleNumber: dProf.vehicleNumber,
        rating: dProf.rating || 4.8,
        todayTrips: dProf.totalTrips || 0,
        lat,
        lng
      };

      const scored = this.scoreCandidate(fullDriverObj, order, pickupLat, pickupLng);
      candidates.push(scored);
    }

    // Sort candidates by totalScore descending
    return candidates.sort((a, b) => b.totalScore - a.totalScore);
  }

  /**
   * Deterministically assigns next best driver to order with 30s atomic offer lock
   */
  async findAndOfferDriver(orderId) {
    const dispatchStart = Date.now();
    metricsService.increment('dispatch_attempts_total');
    logger.info('dispatch_started', `Dispatch started for order ${orderId}`, { orderId, service: 'dispatch' });

    const trip = db.getTripById(orderId);
    if (!trip) return { success: false, error: 'Trip not found' };

    // Check if order is in valid dispatch state (SEARCHING_DRIVER or CREATED)
    if (trip.status !== DELIVERY_STATES.SEARCHING_DRIVER && trip.status !== DELIVERY_STATES.CREATED) {
      return { success: false, error: `Order is in status ${trip.status}, not eligible for dispatch` };
    }

    // Ensure transition to SEARCHING_DRIVER if currently CREATED
    if (trip.status === DELIVERY_STATES.CREATED) {
      await deliveryStateMachine.transition(orderId, DELIVERY_STATES.SEARCHING_DRIVER, { type: 'SYSTEM', id: 'DISPATCH_ENGINE' }, { reason: 'Initiating dispatch search' });
    }

    // Fetch ranked candidate drivers
    const candidates = await this.getCandidateDrivers(trip);
    if (candidates.length === 0) {
      metricsService.increment('dispatch_no_driver_total');
      logger.warn('dispatch_no_driver', `No eligible drivers found for order ${orderId}`, { orderId, service: 'dispatch' });
      metricsService.recordLatency('dispatch_latency', Date.now() - dispatchStart);
      return {
        success: false,
        orderId,
        status: DELIVERY_STATES.SEARCHING_DRIVER,
        message: 'No eligible drivers currently available within radius'
      };
    }

    let topCandidate = null;
    let lockInfo = null;

    // Evaluate candidate pool in rank order and attempt atomic Redis lock acquisition
    for (const candidate of candidates) {
      logger.info('driver_candidate_selected', `Evaluated driver candidate ${candidate.driverId} with score ${candidate.totalScore}`, { orderId, driverId: candidate.driverId, score: candidate.totalScore, service: 'dispatch' });
      const lockRes = await redisLockManager.acquireDriverLock(candidate.driverId, orderId, this.OFFER_TIMEOUT_MS);
      if (lockRes.success) {
        topCandidate = candidate;
        lockInfo = lockRes;
        break;
      } else {
        console.log(`[DispatchService] Candidate driver ${candidate.driverId} locked by competing order, evaluating next candidate...`);
      }
    }

    if (!topCandidate || !lockInfo) {
      metricsService.increment('dispatch_no_driver_total');
      logger.warn('dispatch_all_locked', `All candidates locked for order ${orderId}`, { orderId, candidateCount: candidates.length, service: 'dispatch' });
      metricsService.recordLatency('dispatch_latency', Date.now() - dispatchStart);
      return {
        success: false,
        orderId,
        status: DELIVERY_STATES.SEARCHING_DRIVER,
        message: 'All candidate drivers currently reserved by competing dispatch requests'
      };
    }

    const offerExpiresAt = lockInfo.expiresAt || (Date.now() + this.OFFER_TIMEOUT_MS);

    // Perform atomic state machine transition: SEARCHING_DRIVER -> DRIVER_ASSIGNED
    const transitionResult = await deliveryStateMachine.transition(orderId, DELIVERY_STATES.DRIVER_ASSIGNED, { type: 'SYSTEM', id: 'DISPATCH_ENGINE' }, {
      reason: `Matched candidate ${topCandidate.driverName} (Score: ${topCandidate.totalScore}, Distance: ${topCandidate.distKm}km)`,
      metadata: {
        assignedDriver: topCandidate,
        offerExpiresAt,
        reservationId: lockInfo.reservationId
      }
    });

    if (!transitionResult.success) {
      // Transition failed: release acquired lock
      await redisLockManager.releaseDriverLock(topCandidate.driverId, lockInfo.reservationId);
      return transitionResult;
    }

    // Attach assigned driver details to trip object in database
    const dbStore = db.getDb();
    const dbTrip = dbStore.trips.find(t => t.id === orderId);
    if (dbTrip) {
      dbTrip.driver = {
        id: topCandidate.driverId,
        name: topCandidate.driverName,
        phone: topCandidate.phone,
        vehicleNumber: topCandidate.vehicleNumber,
        rating: 4.9,
        currentLat: topCandidate.lat,
        currentLng: topCandidate.lng
      };
      db.saveDb(dbStore);
    }

    // Set 30-Second Offer Reservation Lock
    await this.clearExistingOffer(orderId);

    const timerId = setTimeout(async () => {
      console.log(`[DispatchService] Offer timeout (30s) expired for order ${orderId}, driver ${topCandidate.driverId}`);
      metricsService.increment('dispatch_offer_timeout_total');
      await this.handleOfferTimeout(orderId, topCandidate.driverId);
    }, this.OFFER_TIMEOUT_MS);

    this.activeOffers.set(orderId, {
      driverId: topCandidate.driverId,
      reservationId: lockInfo.reservationId,
      offerExpiresAt,
      timerId
    });

    metricsService.increment('dispatch_success_total');
    metricsService.increment('dispatch_offer_created_total');
    metricsService.recordLatency('dispatch_latency', Date.now() - dispatchStart);
    logger.info('dispatch_offer_created', `Dispatch offer created for driver ${topCandidate.driverId} on order ${orderId}`, { orderId, driverId: topCandidate.driverId, reservationId: lockInfo.reservationId, service: 'dispatch' });

    // Broadcast WebSocket offer event to driver control room
    websocketService.broadcastToRoom(`driver:${topCandidate.driverId}`, 'dispatch:offer_created', {
      orderId,
      driverId: topCandidate.driverId,
      pickupAddress: trip.pickupAddress,
      dropAddress: trip.dropAddress,
      totalFare: trip.totalFare,
      distKm: topCandidate.distKm,
      etaMin: topCandidate.etaMin,
      offerExpiresAt,
      reservationId: lockInfo.reservationId
    });

    return {
      success: true,
      orderId,
      assignedDriver: topCandidate,
      reservationId: lockInfo.reservationId,
      offerExpiresAt,
      candidatesEvaluated: candidates.length
    };
  }

  /**
   * Driver Declines Offer -> Transition back to SEARCHING_DRIVER & Re-dispatch
   */
  async handleDriverDecline(orderId, driverId, reason = 'Driver declined offer') {
    metricsService.increment('dispatch_offer_declined_total');
    logger.info('dispatch_offer_declined', `Driver ${driverId} declined offer for order ${orderId}`, { orderId, driverId, service: 'dispatch' });

    const offer = this.activeOffers.get(orderId);
    const reservationId = offer ? offer.reservationId : null;
    await this.clearExistingOffer(orderId);
    await redisLockManager.releaseDriverLock(driverId, reservationId || orderId);

    // Track decline in cluster Redis set and local cache
    await redisLockManager.addDeclinedDriver(orderId, driverId);
    if (!this.declinedDrivers.has(orderId)) {
      this.declinedDrivers.set(orderId, new Set());
    }
    this.declinedDrivers.get(orderId).add(driverId);

    // Transition state: DRIVER_ASSIGNED -> SEARCHING_DRIVER
    const transitionRes = await deliveryStateMachine.transition(orderId, DELIVERY_STATES.SEARCHING_DRIVER, { type: 'DRIVER', id: driverId }, {
      reason: `Driver declined offer: ${reason}`
    });

    if (!transitionRes.success) {
      return transitionRes;
    }

    // Re-trigger dispatch engine immediately to match next-best candidate
    return await this.findAndOfferDriver(orderId);
  }

  /**
   * 30-Second Offer Timeout Expired -> Transition back to SEARCHING_DRIVER & Re-dispatch
   */
  async handleOfferTimeout(orderId, driverId) {
    const offer = this.activeOffers.get(orderId);
    const reservationId = offer ? offer.reservationId : null;
    await this.clearExistingOffer(orderId);
    await redisLockManager.releaseDriverLock(driverId, reservationId || orderId);

    await redisLockManager.addDeclinedDriver(orderId, driverId);
    if (!this.declinedDrivers.has(orderId)) {
      this.declinedDrivers.set(orderId, new Set());
    }
    this.declinedDrivers.get(orderId).add(driverId);

    const trip = db.getTripById(orderId);
    if (!trip || trip.status !== DELIVERY_STATES.DRIVER_ASSIGNED) {
      return; // Order already accepted or cancelled
    }

    // Transition state: DRIVER_ASSIGNED -> SEARCHING_DRIVER
    await deliveryStateMachine.transition(orderId, DELIVERY_STATES.SEARCHING_DRIVER, { type: 'SYSTEM', id: 'DISPATCH_TIMEOUT' }, {
      reason: `Offer timed out after ${this.OFFER_TIMEOUT_MS/1000}s for driver ${driverId}`
    });

    // Re-dispatch to next best candidate
    await this.findAndOfferDriver(orderId);
  }

  /**
   * Driver Accepts Offer or Order Cleared -> Clears offer reservation lock and timer
   */
  async clearExistingOffer(orderId) {
    if (this.activeOffers.has(orderId)) {
      const offer = this.activeOffers.get(orderId);
      if (offer.timerId) clearTimeout(offer.timerId);
      if (offer.driverId) {
        await redisLockManager.releaseDriverLock(offer.driverId, offer.reservationId || orderId);
      }
      this.activeOffers.delete(orderId);
    }
  }

  /**
   * Complete dispatch reset for testing / environment teardown
   */
  async resetDispatchState() {
    for (const [orderId, offer] of this.activeOffers.entries()) {
      if (offer.timerId) clearTimeout(offer.timerId);
      if (offer.driverId) {
        await redisLockManager.releaseDriverLock(offer.driverId, offer.reservationId || orderId);
      }
    }
    this.activeOffers.clear();
    this.declinedDrivers.clear();
  }

  /**
   * Returns current offer status for an order
   */
  getOfferStatus(orderId) {
    const offer = this.activeOffers.get(orderId);
    if (!offer) return { active: false };

    const remainingMs = Math.max(0, offer.offerExpiresAt - Date.now());
    return {
      active: true,
      driverId: offer.driverId,
      remainingMs,
      remainingSec: Math.ceil(remainingMs / 1000)
    };
  }
}

const dispatchService = new DispatchService();

module.exports = {
  DispatchService,
  dispatchService
};
