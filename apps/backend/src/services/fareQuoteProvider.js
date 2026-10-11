const { calculateFareEstimates } = require('./fareService');
const { zoneService } = require('./zoneService');

/**
 * VAAYU Milestone 7 Phase 7.2: FareQuoteProvider Interface Abstraction
 * 
 * Objectives:
 * 1. Provides a decoupled provider interface for customer fare calculation.
 * 2. Isolates customer booking workflows from the internal fare engine implementation.
 * 3. Supports multi-category estimates, helper add-ons, extra drops, and outstation trips.
 */
class FareQuoteProvider {
  constructor(engine = null) {
    this.engine = engine || { calculateFareEstimates };
  }

  /**
   * Generates fare quotes for a customer route
   */
  async getFareQuote(pickupLat, pickupLng, dropLat, dropLng, options = {}) {
    const {
      vehicleId = null,
      helperCount = 0,
      extraDropsCount = 0,
      isOutstation = false,
      intermediateStops = [],
      waitingTimeMinutes = 0
    } = options;

    const pLat = Number(pickupLat);
    const pLng = Number(pickupLng);
    const dLat = Number(dropLat);
    const dLng = Number(dropLng);
    const coordinates = [[pLat, pLng], [dLat, dLng]];
    if (coordinates.some(([lat, lng]) => !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) {
      return { success: false, error: 'Valid pickup and drop coordinates are required.', code: 'INVALID_ROUTE_COORDINATES' };
    }
    const pickupZone = zoneService.findPickupZone(pLat, pLng);
    if (pickupZone?.status === 'RESTRICTED') {
      return { success: false, error: 'Bookings are temporarily unavailable in the pickup zone.', code: 'PICKUP_ZONE_RESTRICTED', pickupZone };
    }

    const rawEstimates = await this.engine.calculateFareEstimates(
      pLat,
      pLng,
      dLat,
      dLng,
      helperCount,
      extraDropsCount,
      isOutstation,
      intermediateStops,
      waitingTimeMinutes,
      pickupZone
    );

    let selectedVehicleEstimate = null;
    if (vehicleId) {
      selectedVehicleEstimate = rawEstimates.estimates.find(e => e.vehicleId === vehicleId) || null;
    }

    return {
      success: true,
      provider: 'VAAYU_FARE_QUOTE_V1',
      pickup: { lat: pLat, lng: pLng },
      drop: { lat: dLat, lng: dLng },
      distanceKm: rawEstimates.distanceKm,
      durationMin: rawEstimates.durationMin,
      routeProvider: rawEstimates.routeProvider,
      routeQuality: rawEstimates.routeQuality,
      isDegraded: rawEstimates.isDegraded,
      routePoints: rawEstimates.routePoints,
      pricingZone: rawEstimates.pricingZone,
      isOutstation,
      estimates: rawEstimates.estimates,
      selectedEstimate: selectedVehicleEstimate || rawEstimates.estimates[0]
    };
  }
}

const fareQuoteProvider = new FareQuoteProvider();

module.exports = {
  FareQuoteProvider,
  fareQuoteProvider
};
