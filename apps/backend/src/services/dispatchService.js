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
 * VAAYU deterministic dispatch engine.
 *
 * Important concurrency invariant: an offer callback is valid only while the
 * same driver + reservation still owns the persisted DRIVER_ASSIGNED trip.
 * This prevents delayed accept/decline/timeout messages from an old offer from
 * cancelling or replacing a newer offer after a rapid re-dispatch.
 */
class DispatchService {
  constructor() {
    this.activeOffers = new Map();
    this.declinedDrivers = new Map();
    this.OFFER_TIMEOUT_MS = 30000;
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
        offerExpiresAt: offer.offerExpiresAt,
        reservationId: offer.reservationId
      });
    }
    return offers;
  }

  _offerStillOwned(orderId, driverId, offer) {
    if (!offer || String(offer.driverId) !== String(driverId)) return false;
    const trip = db.getTripById(orderId);
    if (!trip || trip.status !== DELIVERY_STATES.DRIVER_ASSIGNED) return false;
    const assignedDriverId = trip.driver?.id || trip.driver?.userId;
    if (String(assignedDriverId) !== String(driverId)) return false;
    if (offer.offerExpiresAt && Number(offer.offerExpiresAt) <= Date.now()) return false;
    return true;
  }

  async handleDriverAccept(orderId, driverId) {
    const trip = db.getTripById(orderId);
    const assignedDriverId = trip?.driver?.id || trip?.driver?.userId;
    const offer = this.activeOffers.get(orderId);
    if (!trip || String(assignedDriverId) !== String(driverId)) {
      return { success: false, error: 'This offer is not assigned to the driver.', code: 'DISPATCH_OFFER_STALE' };
    }
    if (!this._offerStillOwned(orderId, driverId, offer)) {
      return { success: false, error: 'This dispatch offer is no longer active.', code: 'DISPATCH_OFFER_STALE' };
    }

    const reservationId = offer.reservationId || orderId;
    const currentLock = await redisLockManager.getDriverLock(driverId);
    if (!currentLock || currentLock.orderId !== orderId || (offer.reservationId && currentLock.reservationId !== offer.reservationId)) {
      return { success: false, error: 'The dispatch reservation is no longer owned by this offer.', code: 'DISPATCH_RESERVATION_STALE' };
    }

    if (offer.timerId) clearTimeout(offer.timerId);
    this.activeOffers.delete(orderId);
    await redisLockManager.releaseDriverLock(driverId, reservationId);
    return { success: true, orderId, driverId, reservationId };
  }

  scoreCandidate(driver, order, pickupLat, pickupLng) {
    const pickupEtaObj = routingService.calculatePickupEtaSync(driver.lat, driver.lng, pickupLat, pickupLng, driver.vehicleId || order.vehicleId);
    const distKm = pickupEtaObj.distKm;
    const etaMin = pickupEtaObj.pickupEtaMin;
    const distanceScore = Math.max(0, 100 - (distKm * 8)) * this.WEIGHTS.DISTANCE;
    const etaScore = Math.max(0, 60 - (etaMin * 2)) * this.WEIGHTS.ETA;
    const rating = parseFloat(driver.rating) || 4.5;
    const ratingScore = rating * this.WEIGHTS.RATING;
    const capacityScore = (driver.vehicleId === order.vehicleId) ? this.WEIGHTS.CAPACITY_FIT : 0;
    const todayTrips = parseInt(driver.todayTrips || driver.todayTripsCount || 0, 10);
    const workloadPenalty = Math.min(30, todayTrips * this.WEIGHTS.WORKLOAD_PENALTY);
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

  async getCandidateDrivers(order) {
    const pickupLat = parseFloat(order.pickupLat);
    const pickupLng = parseFloat(order.pickupLng);
    const requiredVehicleId = order.vehicleId;
    const redisDeclined = await redisLockManager.getDeclinedDrivers(order.id);
    const localDeclined = this.declinedDrivers.get(order.id) || new Set();
    const declinedSet = new Set([...localDeclined, ...redisDeclined]);

    const dbDrivers = db.getDrivers() || [];
    const now = Date.now();
    const activeTrips = (db.getTrips() || []).filter(t => {
      if (t.status === 'DELIVERED' || t.status === 'CANCELLED' || t.status === 'FAILED' || t.status === 'CREATED' || t.status === 'SEARCHING_DRIVER') return false;
      const tripAgeMs = t.createdAt ? (now - new Date(t.createdAt).getTime()) : 0;
      return tripAgeMs < 1800000;
    });
    const busyDriverIds = new Set(activeTrips.filter(t => t.id !== order.id && t.driver).map(t => (t.driver.id || t.driver.userId)));
    const candidates = [];

    for (const dProf of dbDrivers) {
      const driverId = dProf.id || dProf.userId;
      if (declinedSet.has(driverId)) continue;
      if (busyDriverIds.has(driverId)) continue;

      const existingLock = await redisLockManager.getDriverLock(driverId);
      if (existingLock && existingLock.orderId !== order.id) continue;

      // Dispatch must use fresh server-observed telemetry. A profile's last-known
      // coordinates are identity metadata, not proof that an ONLINE driver is
      // currently reachable. Falling back to them can select stale/offline drivers.
      const telemetry = await driverLocationService.getDriverState(driverId);
      if (!telemetry) continue;
      const lat = telemetry.lat;
      const lng = telemetry.lng;
      const liveness = telemetry.livenessState;
      const status = telemetry.status;
      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) continue;
      if (liveness !== 'HEALTHY' && liveness !== 'DEGRADED') continue;
      if (status === 'OFFLINE' || telemetry.currentTripId) continue;
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
      candidates.push(this.scoreCandidate(fullDriverObj, order, pickupLat, pickupLng));
    }

    return candidates.sort((a, b) => b.totalScore - a.totalScore);
  }

  async findAndOfferDriver(orderId) {
    const dispatchStart = Date.now();
    metricsService.increment('dispatch_attempts_total');
    logger.info('dispatch_started', `Dispatch started for order ${orderId}`, { orderId, service: 'dispatch' });

    const trip = db.getTripById(orderId);
    if (!trip) return { success: false, error: 'Trip not found' };
    if (trip.status !== DELIVERY_STATES.SEARCHING_DRIVER && trip.status !== DELIVERY_STATES.CREATED) {
      return { success: false, error: `Order is in status ${trip.status}, not eligible for dispatch` };
    }

    if (trip.status === DELIVERY_STATES.CREATED) {
      const searchTransition = await deliveryStateMachine.transition(orderId, DELIVERY_STATES.SEARCHING_DRIVER, { type: 'SYSTEM', id: 'DISPATCH_ENGINE' }, { reason: 'Initiating dispatch search' });
      if (!searchTransition.success) return searchTransition;
    }

    const candidates = await this.getCandidateDrivers(trip);
    if (candidates.length === 0) {
      metricsService.increment('dispatch_no_driver_total');
      logger.warn('dispatch_no_driver', `No eligible drivers found for order ${orderId}`, { orderId, service: 'dispatch' });
      metricsService.recordLatency('dispatch_latency', Date.now() - dispatchStart);
      return { success: false, orderId, status: DELIVERY_STATES.SEARCHING_DRIVER, message: 'No eligible drivers currently available within radius' };
    }

    let topCandidate = null;
    let lockInfo = null;
    for (const candidate of candidates) {
      logger.info('driver_candidate_selected', `Evaluated driver candidate ${candidate.driverId} with score ${candidate.totalScore}`, { orderId, driverId: candidate.driverId, score: candidate.totalScore, service: 'dispatch' });
      const lockRes = await redisLockManager.acquireDriverLock(candidate.driverId, orderId, this.OFFER_TIMEOUT_MS);
      if (lockRes.success) {
        topCandidate = candidate;
        lockInfo = lockRes;
        break;
      }
    }

    if (!topCandidate || !lockInfo) {
      metricsService.increment('dispatch_no_driver_total');
      logger.warn('dispatch_all_locked', `All candidates locked for order ${orderId}`, { orderId, candidateCount: candidates.length, service: 'dispatch' });
      metricsService.recordLatency('dispatch_latency', Date.now() - dispatchStart);
      return { success: false, orderId, status: DELIVERY_STATES.SEARCHING_DRIVER, message: 'All candidate drivers currently reserved by competing dispatch requests' };
    }

    const offerExpiresAt = lockInfo.expiresAt || (Date.now() + this.OFFER_TIMEOUT_MS);
    const transitionResult = await deliveryStateMachine.transition(orderId, DELIVERY_STATES.DRIVER_ASSIGNED, { type: 'SYSTEM', id: 'DISPATCH_ENGINE' }, {
      reason: `Matched candidate ${topCandidate.driverName} (Score: ${topCandidate.totalScore}, Distance: ${topCandidate.distKm}km)`,
      metadata: {
        assignedDriver: topCandidate,
        offerExpiresAt,
        reservationId: lockInfo.reservationId
      }
    });

    if (!transitionResult.success) {
      await redisLockManager.releaseDriverLock(topCandidate.driverId, lockInfo.reservationId);
      return transitionResult;
    }

    await this.clearExistingOffer(orderId);

    const timerId = setTimeout(async () => {
      await this.handleOfferTimeout(orderId, topCandidate.driverId, lockInfo.reservationId);
    }, Math.max(0, offerExpiresAt - Date.now()));

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

    return { success: true, orderId, assignedDriver: topCandidate, reservationId: lockInfo.reservationId, offerExpiresAt, candidatesEvaluated: candidates.length };
  }

  async handleDriverDecline(orderId, driverId, reason = 'Driver declined offer') {
    const offer = this.activeOffers.get(orderId);
    if (!this._offerStillOwned(orderId, driverId, offer)) {
      metricsService.increment('dispatch_stale_offer_action_total');
      return { success: false, error: 'The dispatch offer is no longer active for this driver.', code: 'DISPATCH_OFFER_STALE' };
    }

    metricsService.increment('dispatch_offer_declined_total');
    logger.info('dispatch_offer_declined', `Driver ${driverId} declined offer for order ${orderId}`, { orderId, driverId, service: 'dispatch' });

    const reservationId = offer.reservationId;
    await this.clearExistingOffer(orderId);
    await redisLockManager.addDeclinedDriver(orderId, driverId);
    if (!this.declinedDrivers.has(orderId)) this.declinedDrivers.set(orderId, new Set());
    this.declinedDrivers.get(orderId).add(driverId);

    const transitionRes = await deliveryStateMachine.transition(orderId, DELIVERY_STATES.SEARCHING_DRIVER, { type: 'DRIVER', id: driverId }, {
      reason: `Driver declined offer: ${reason}`
    });
    if (!transitionRes.success) return transitionRes;
    return await this.findAndOfferDriver(orderId);
  }

  async handleOfferTimeout(orderId, driverId, expectedReservationId = null) {
    const offer = this.activeOffers.get(orderId);
    if (!offer || String(offer.driverId) !== String(driverId) || (expectedReservationId && offer.reservationId !== expectedReservationId)) {
      metricsService.increment('dispatch_stale_offer_timeout_total');
      return { success: false, code: 'DISPATCH_OFFER_STALE' };
    }
    if (!this._offerStillOwned(orderId, driverId, offer)) {
      metricsService.increment('dispatch_stale_offer_timeout_total');
      return { success: false, code: 'DISPATCH_OFFER_STALE' };
    }

    const reservationId = offer.reservationId;
    await this.clearExistingOffer(orderId);
    await redisLockManager.addDeclinedDriver(orderId, driverId);
    if (!this.declinedDrivers.has(orderId)) this.declinedDrivers.set(orderId, new Set());
    this.declinedDrivers.get(orderId).add(driverId);

    const trip = db.getTripById(orderId);
    if (!trip || trip.status !== DELIVERY_STATES.DRIVER_ASSIGNED) return { success: false, code: 'DISPATCH_TRIP_NOT_ASSIGNED' };

    const transitionRes = await deliveryStateMachine.transition(orderId, DELIVERY_STATES.SEARCHING_DRIVER, { type: 'SYSTEM', id: 'DISPATCH_TIMEOUT' }, {
      reason: `Offer timed out after ${this.OFFER_TIMEOUT_MS/1000}s for driver ${driverId}`,
      metadata: { reservationId }
    });
    if (!transitionRes.success) return transitionRes;

    return await this.findAndOfferDriver(orderId);
  }

  async clearExistingOffer(orderId) {
    if (this.activeOffers.has(orderId)) {
      const offer = this.activeOffers.get(orderId);
      if (offer.timerId) clearTimeout(offer.timerId);
      if (offer.driverId) await redisLockManager.releaseDriverLock(offer.driverId, offer.reservationId || orderId);
      this.activeOffers.delete(orderId);
    }
  }

  async resetDispatchState() {
    for (const [orderId, offer] of this.activeOffers.entries()) {
      if (offer.timerId) clearTimeout(offer.timerId);
      if (offer.driverId) await redisLockManager.releaseDriverLock(offer.driverId, offer.reservationId || orderId);
    }
    this.activeOffers.clear();
    this.declinedDrivers.clear();
  }

  getOfferStatus(orderId) {
    const offer = this.activeOffers.get(orderId);
    if (!offer) return { active: false };
    const remainingMs = Math.max(0, offer.offerExpiresAt - Date.now());
    return { active: true, driverId: offer.driverId, remainingMs, remainingSec: Math.ceil(remainingMs / 1000), reservationId: offer.reservationId };
  }
}

const dispatchService = new DispatchService();

module.exports = { DispatchService, dispatchService };