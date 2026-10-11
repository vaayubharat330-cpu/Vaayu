const db = require('../db/database');
const { calculateRoute } = require('./routingService');
const { fareCache } = require('./lruCacheService');
const { zoneService } = require('./zoneService');

async function calculateFareEstimates(pickupLat, pickupLng, dropLat, dropLng, helperCount = 0, extraDropsCount = 0, isOutstation = false, intermediateStops = [], waitingTimeMinutes = 0, pickupZone = undefined) {
  const settings = db.getSystemSettings ? db.getSystemSettings() : {};
  const zone = pickupZone === undefined ? zoneService.findPickupZone(Number(pickupLat), Number(pickupLng)) : pickupZone;
  const globalSurgeMultiplier = Math.min(3, Math.max(1, Number(settings.surgeMultiplier) || 1));
  const surgeMultiplier = Math.min(3, globalSurgeMultiplier * (zone ? Math.max(1, zone.surgeMultiplier) : 1));
  const cacheKey = `fare_${pickupLat}_${pickupLng}_${dropLat}_${dropLng}_${helperCount}_${extraDropsCount}_${isOutstation}_${waitingTimeMinutes}_${surgeMultiplier}_${zone?.id || 'no-zone'}`;
  const cached = fareCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const route = await calculateRoute(pickupLat, pickupLng, dropLat, dropLng, intermediateStops);
  const vehicles = db.getVehicles();

  const effectiveExtraDrops = Math.max(extraDropsCount, intermediateStops.length);
  const cleanWaitingTime = Math.max(0, parseInt(waitingTimeMinutes || 0, 10));

  const estimates = vehicles.map(v => {
    let baseFare = v.baseFare;
    let includedKm = v.includedKm;
    let perKmRate = v.perKmRate;
    let driverAllowance = 0;

    if (isOutstation) {
      includedKm = 100;
      driverAllowance = (v.id === 'v_2w' || v.id === 'v_mini_3w') ? 250 : ((v.id === 'v_3w' || v.id === 'v_ace') ? 400 : 600);
      baseFare = Math.round(v.baseFare * 3.5);
      perKmRate = Math.round(v.perKmRate * 1.2);
    }

    const extraDistance = Math.max(0, route.distanceKm - includedKm);
    const distanceFare = extraDistance * perKmRate;
    const timeFare = isOutstation ? 0 : route.durationMin * v.perMinRate;
    
    // Helper calculation: 1 helper = standard fee; 2 helpers = 1.85x fee
    let helperFee = 0;
    if (helperCount === 1) helperFee = v.helperCharge;
    if (helperCount >= 2) helperFee = Math.round(v.helperCharge * 1.85);

    // Extra Drops Fee
    const extraDropFeePerUnit = (v.id === 'v_2w' || v.id === 'v_mini_3w') ? 30 : ((v.id === 'v_3w' || v.id === 'v_ace') ? 60 : 120);
    const extraDropsFee = effectiveExtraDrops * extraDropFeePerUnit;

    // Waiting Time Fee (First 5 mins FREE, then ₹3/min for extra waiting time)
    const freeWaitingMins = 5;
    const billableWaitingMins = Math.max(0, cleanWaitingTime - freeWaitingMins);
    const waitingRatePerMin = 3;
    const waitingFee = billableWaitingMins * waitingRatePerMin;

    const subtotal = baseFare + distanceFare + timeFare + helperFee + extraDropsFee + waitingFee + driverAllowance;
    const surgeFare = Math.round(subtotal * surgeMultiplier);
    const tollFee = zone?.tollFee || 0;
    const totalFare = surgeFare + tollFee;

    return {
      vehicleId: v.id,
      vehicleName: v.name,
      code: v.code,
      capacityKg: v.capacityKg,
      dimensions: v.dimensions,
      description: v.description,
      icon: v.icon,
      distanceKm: route.distanceKm,
      durationMin: route.durationMin,
      isOutstation,
      waitingTimeMinutes: cleanWaitingTime,
      fareBreakdown: {
        baseFare,
        includedKm,
        extraDistanceKm: Math.round(extraDistance * 10) / 10,
        distanceFare: Math.round(distanceFare),
        timeFare: Math.round(timeFare),
        driverAllowance,
        helperFee,
        extraDropsFee,
        waitingFee,
        surgeMultiplier,
        globalSurgeMultiplier,
        zoneSurgeMultiplier: zone ? zone.surgeMultiplier : 1,
        pricingZoneId: zone?.id || null,
        tollFee,
        surgeAdjustment: surgeFare - Math.round(subtotal),
        totalFare
      },
      totalFare,
      etaMinutes: Math.round(route.distanceKm * (isOutstation ? 1.5 : 2.5)) + 5
    };
  });

  const result = {
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
    routePoints: route.routePoints,
    routeProvider: route.provider,
    routeQuality: route.routeQuality || (route.isDegraded ? 'ESTIMATED' : 'ROAD_NETWORK'),
    isDegraded: Boolean(route.isDegraded),
    isOutstation,
    pricingZone: zone,
    estimates
  };

  fareCache.set(cacheKey, result);
  return result;
}

module.exports = {
  calculateFareEstimates
};
