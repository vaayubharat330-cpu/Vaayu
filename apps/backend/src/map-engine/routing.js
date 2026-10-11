const https = require('https');
const http = require('http');
const url = require('url');
const { metricsService } = require('../services/metricsService');

/**
 * VAAYU Milestone 5: Routing & Dynamic ETA Engine
 * 
 * Objectives:
 * 1. Provider-independent routing architecture (Google, OSRM, Fallback Haversine).
 * 2. Vehicle-specific speed profiles (2-wheeler, 3-wheeler, Tata Ace / trucks) & city vs outstation speed factors.
 * 3. High-performance LRU / TTL caching to eliminate redundant external network calls.
 * 4. Dynamic pickup ETA & delivery trip duration estimation.
 * 5. Real-time live ETA recalculation based on driver telemetry in active trip states.
 */

// Vehicle Speed Profiles (km/h) for urban driving in Hyderabad
const VEHICLE_SPEED_PROFILES = {
  'v_2w': { name: '2-Wheeler / Bike', avgSpeedKmH: 30, accelerationFactor: 1.15 },
  'v_mini_3w': { name: 'Mini 3-Wheeler', avgSpeedKmH: 22, accelerationFactor: 1.0 },
  'v_3w': { name: '3-Wheeler (Auto)', avgSpeedKmH: 22, accelerationFactor: 1.0 },
  'v_ace': { name: 'Tata Ace (7ft)', avgSpeedKmH: 18, accelerationFactor: 0.9 },
  'v_pickup': { name: '8ft Pickup / Bolero', avgSpeedKmH: 18, accelerationFactor: 0.85 },
  'v_8ft': { name: '8ft Truck', avgSpeedKmH: 18, accelerationFactor: 0.85 },
  'DEFAULT': { name: 'Standard City Vehicle', avgSpeedKmH: 22, accelerationFactor: 1.0 }
};

// 1. Haversine Distance Formula (km)
function haversineDistance(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return NaN;
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const boundedA = Math.min(1, Math.max(0, a));
  const c = 2 * Math.atan2(Math.sqrt(boundedA), Math.sqrt(1 - boundedA));
  return R * c;
}

function decodeGooglePolyline(encoded) {
  if (typeof encoded !== 'string' || !encoded) return [];
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  try {
    while (index < encoded.length) {
      const deltas = [];
      for (let axis = 0; axis < 2; axis++) {
        let result = 0;
        let shift = 0;
        let byte;
        do {
          if (index >= encoded.length || shift > 30) return [];
          byte = encoded.charCodeAt(index++) - 63;
          if (byte < 0 || byte > 63) return [];
          result |= (byte & 0x1f) << shift;
          shift += 5;
        } while (byte >= 0x20);
        deltas.push((result & 1) ? ~(result >> 1) : (result >> 1));
      }
      lat += deltas[0];
      lng += deltas[1];
      points.push([lat / 1e5, lng / 1e5]);
    }
  } catch (_) {
    return [];
  }
  return points;
}

function isValidCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

// 2. Base Routing Provider Abstract Class
class BaseRoutingProvider {
  constructor(name) {
    this.name = name;
  }

  async calculateRoute(waypoints, options = {}) {
    throw new Error(`calculateRoute not implemented in provider ${this.name}`);
  }
}

// 3. Google Maps Routing Provider Adapter
class GoogleRoutingProvider extends BaseRoutingProvider {
  constructor(apiKey = process.env.GOOGLE_MAPS_API_KEY) {
    super('GoogleRoutingProvider');
    this.apiKey = apiKey;
  }

  isAvailable() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 5);
  }

  async calculateRoute(waypoints, options = {}) {
    if (!this.isAvailable()) return null;
    if (!waypoints || waypoints.length < 2) return null;

    try {
      const originStr = `${waypoints[0].lat},${waypoints[0].lng}`;
      const destStr = `${waypoints[waypoints.length - 1].lat},${waypoints[waypoints.length - 1].lng}`;
      
      let waypointsParam = '';
      if (waypoints.length > 2) {
        const intermediates = waypoints.slice(1, -1).map(w => `${w.lat},${w.lng}`).join('|');
        waypointsParam = `&waypoints=${encodeURIComponent(intermediates)}`;
      }

      const googleUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${originStr}&destination=${destStr}${waypointsParam}&mode=driving&key=${this.apiKey}`;

      return new Promise((resolve) => {
        const req = https.get(googleUrl, { timeout: 3000 }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (data.status === 'OK' && data.routes && data.routes[0]) {
                const route = data.routes[0];
                let totalDistMeters = 0;
                let totalDurationSec = 0;
                for (const leg of route.legs) {
                  totalDistMeters += leg.distance ? leg.distance.value : 0;
                  totalDurationSec += leg.duration ? leg.duration.value : 0;
                }
                const distanceKm = Math.round((totalDistMeters / 1000) * 10) / 10;
                const durationMin = Math.max(1, Math.round(totalDurationSec / 60));

                const routePoints = decodeGooglePolyline(route.overview_polyline?.points);
                if (routePoints.length < 2) {
                  routePoints.push([waypoints[0].lat, waypoints[0].lng]);
                  routePoints.push([waypoints[waypoints.length - 1].lat, waypoints[waypoints.length - 1].lng]);
                }

                return resolve({
                  distanceKm,
                  durationMin,
                  routePoints,
                  provider: this.name
                });
              }
            } catch (e) {}
            resolve(null);
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
    } catch (e) {
      return null;
    }
  }
}

// 4. OSRM (Open Source Routing Machine) Provider Adapter
class OSRMProvider extends BaseRoutingProvider {
  // OSRM has no production SLA on the public demo server. Set OSRM_BASE_URL to a self-hosted instance.
  constructor(baseUrl = process.env.OSRM_BASE_URL || 'https://router.project-osrm.org') {
    super('OSRMProvider');
    this.baseUrl = baseUrl;
  }

  async calculateRoute(waypoints, options = {}) {
    if (!waypoints || waypoints.length < 2) return null;
    try {
      const coordsStr = waypoints.map(w => `${w.lng},${w.lat}`).join(';');
      const osrmUrl = `${this.baseUrl}/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`;

      return new Promise((resolve) => {
        const client = osrmUrl.startsWith('https') ? https : http;
        const req = client.get(osrmUrl, { headers: { 'User-Agent': 'VaayuApp/1.0' }, timeout: 3500 }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              if (json.code === 'Ok' && json.routes && json.routes[0]) {
                const r = json.routes[0];
                const distanceKm = Math.round((r.distance / 1000) * 10) / 10;
                const durationMin = Math.max(1, Math.round(r.duration / 60));

                // Convert OSRM GeoJSON [lng, lat] to Leaflet [lat, lng]
                const routePoints = r.geometry ? r.geometry.coordinates.map(c => [c[1], c[0]]) : [];
                return resolve({
                  distanceKm,
                  durationMin,
                  routePoints,
                  provider: this.name
                });
              }
            } catch (e) {}
            resolve(null);
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
    } catch (e) {
      return null;
    }
  }
}

// 5. Fallback Haversine Routing Provider Adapter
class FallbackHaversineRoutingProvider extends BaseRoutingProvider {
  constructor() {
    super('FallbackHaversineProvider');
  }

  async calculateRoute(waypoints, options = {}) {
    if (!waypoints || waypoints.length < 2) return null;

    let totalDistanceKm = 0;
    const routePoints = waypoints.map(point => [point.lat, point.lng]);

    for (let idx = 0; idx < waypoints.length - 1; idx++) {
      const start = waypoints[idx];
      const end = waypoints[idx + 1];
      const segDist = haversineDistance(start.lat, start.lng, end.lat, end.lng);
      totalDistanceKm += segDist;

    }

    // 1.3x road circuity multiplier over straight-line distance
    const drivingDistanceKm = totalDistanceKm < 0.005 ? 0 : Math.round(totalDistanceKm * 1.3 * 10) / 10;
    
    // Vehicle speed profile calculation
    const vehicleId = options.vehicleId || 'DEFAULT';
    const profile = VEHICLE_SPEED_PROFILES[vehicleId] || VEHICLE_SPEED_PROFILES['DEFAULT'];
    const speedKmH = options.isOutstation ? (profile.avgSpeedKmH * 1.4) : profile.avgSpeedKmH;
    
    const durationMinutes = drivingDistanceKm === 0 ? 0 : Math.max(1, Math.round((drivingDistanceKm / speedKmH) * 60) + (options.isOutstation ? 0 : 2));

    return {
      distanceKm: drivingDistanceKm,
      durationMin: durationMinutes,
      routePoints,
      provider: this.name,
      isDegraded: true,
      routeQuality: 'STRAIGHT_LINE_ESTIMATE'
    };
  }
}

// 6. High-Performance LRU/TTL Route Cache
class RouteCache {
  constructor(capacity = 500, ttlMs = 600000) { // 10 minutes TTL
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  getCacheKey(waypoints, vehicleId, isOutstation, provider) {
    const coordsKey = waypoints.map(w => `${w.lat.toFixed(5)},${w.lng.toFixed(5)}`).join('->');
    return `${provider || 'ANY'}:${vehicleId || 'DEF'}:${isOutstation ? 'OUT' : 'LCL'}:${coordsKey}`;
  }

  get(key) {
    if (!this.cache.has(key)) {
      this.misses++;
      return null;
    }
    const item = this.cache.get(key);
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    // Refresh LRU order
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Evict oldest entry
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs
    });
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      capacity: this.capacity,
      hitRatio: total > 0 ? Math.round((this.hits / total) * 100) / 100 : 0
    };
  }
}

// 7. Master Routing Engine Service
class RoutingService {
  constructor() {
    this.googleProvider = new GoogleRoutingProvider();
    this.osrmProvider = new OSRMProvider();
    this.fallbackProvider = new FallbackHaversineRoutingProvider();

    // Default provider priority chain
    this.providers = [
      this.googleProvider,
      this.osrmProvider,
      this.fallbackProvider
    ];

    this.cache = new RouteCache(500, 600000);
  }

  /**
   * Primary Provider-Independent Route & Duration Calculation Method
   */
  async calculateRoute(pickupLat, pickupLng, dropLat, dropLng, intermediateStops = [], options = {}) {
    const routeStart = Date.now();
    metricsService.increment('routing_requests_total');
    metricsService.increment('eta_calculations_total');

    if (!Array.isArray(intermediateStops)) throw new TypeError('intermediateStops must be an array');
    const waypoints = [
      { lat: Number(pickupLat), lng: Number(pickupLng) },
      ...intermediateStops.map(stop => ({ lat: Number(stop?.lat), lng: Number(stop?.lng) })),
      { lat: Number(dropLat), lng: Number(dropLng) }
    ];
    if (waypoints.length > 25) throw new RangeError('A route can contain at most 25 waypoints');
    if (waypoints.some(point => !isValidCoordinate(point.lat, point.lng))) {
      throw new RangeError('Every route waypoint must have valid latitude and longitude');
    }

    const vehicleId = options.vehicleId || 'DEFAULT';
    const isOutstation = Boolean(options.isOutstation);
    const requestedProviderName = options.provider;
    const bypassCache = Boolean(options.bypassCache);

    // 1. Check Cache
    const cacheKey = this.cache.getCacheKey(waypoints, vehicleId, isOutstation, requestedProviderName);
    if (!bypassCache) {
      const cachedResult = this.cache.get(cacheKey);
      if (cachedResult) {
        metricsService.recordLatency('routing_latency', Date.now() - routeStart);
        return {
          ...cachedResult,
          cached: true
        };
      }
    }

    // 2. Select Provider Chain
    let targetProviders = this.providers;
    if (requestedProviderName) {
      if (requestedProviderName === 'Google' || requestedProviderName === 'GoogleRoutingProvider') {
        targetProviders = [this.googleProvider, this.osrmProvider, this.fallbackProvider];
      } else if (requestedProviderName === 'OSRM' || requestedProviderName === 'OSRMProvider') {
        targetProviders = [this.osrmProvider, this.fallbackProvider];
      } else if (requestedProviderName === 'Fallback' || requestedProviderName === 'FallbackHaversineProvider') {
        targetProviders = [this.fallbackProvider];
      }
    }

    // 3. Execute Provider Fallback Loop
    let attemptIndex = 0;
    for (const provider of targetProviders) {
      attemptIndex++;
      try {
        const result = await provider.calculateRoute(waypoints, { vehicleId, isOutstation });
        if (result && Number.isFinite(result.distanceKm) && result.distanceKm >= 0 && Number.isFinite(result.durationMin)) {
          metricsService.increment('routing_provider_success_total');
          if (attemptIndex > 1 || result.isDegraded) {
            metricsService.increment('routing_fallback_total');
          }
          const finalResult = {
            distanceKm: result.distanceKm,
            durationMin: result.durationMin,
            routePoints: result.routePoints || [],
            provider: result.provider,
            isDegraded: Boolean(result.isDegraded),
            routeQuality: result.routeQuality || (result.isDegraded ? 'ESTIMATED' : 'ROAD_NETWORK'),
            cached: false
          };
          // Save in cache
          this.cache.set(cacheKey, finalResult);
          metricsService.recordLatency('routing_latency', Date.now() - routeStart);
          return finalResult;
        }
      } catch (err) {
        metricsService.increment('routing_provider_failure_total');
        console.warn(`[RoutingService] Provider ${provider.name} failed: ${err.message}`);
      }
    }

    // Ultimate fallback if loop unexpectedly completes without result
    metricsService.increment('routing_fallback_total');
    const fallbackRes = await this.fallbackProvider.calculateRoute(waypoints, { vehicleId, isOutstation });
    metricsService.recordLatency('routing_latency', Date.now() - routeStart);
    return {
      ...fallbackRes,
      cached: false
    };
  }

  /**
   * Fast Synchronous Pickup Distance & Duration Estimate (Used for Dispatch Scoring)
   */
  calculatePickupEtaSync(driverLat, driverLng, pickupLat, pickupLng, vehicleId = 'DEFAULT') {
    const distStraight = haversineDistance(driverLat, driverLng, pickupLat, pickupLng);
    const distKm = Math.max(0.1, Math.round(distStraight * 1.3 * 100) / 100);
    
    const profile = VEHICLE_SPEED_PROFILES[vehicleId] || VEHICLE_SPEED_PROFILES['DEFAULT'];
    const durationMin = Math.max(1, Math.round((distKm / profile.avgSpeedKmH) * 60));

    return {
      distKm,
      durationMin,
      pickupEtaMin: durationMin + 2 // +2 mins buffer for driver turnaround
    };
  }

  /**
   * Async Pickup Drive ETA
   */
  async calculatePickupEta(driverLat, driverLng, pickupLat, pickupLng, vehicleId = 'DEFAULT') {
    const route = await this.calculateRoute(driverLat, driverLng, pickupLat, pickupLng, [], { vehicleId });
    return {
      distKm: route.distanceKm,
      durationMin: route.durationMin,
      pickupEtaMin: route.durationMin + 2,
      provider: route.provider
    };
  }

  /**
   * Dynamic Real-time Live ETA calculation for active trip
   */
  async calculateLiveEta(trip, driverTelemetry = null) {
    if (!trip) return { success: false, error: 'Trip not found' };

    const status = trip.status;
    const vehicleId = trip.vehicleId || 'DEFAULT';

    // 1. Pickup Phase (SEARCHING_DRIVER, DRIVER_ASSIGNED, DRIVER_ACCEPTED, DRIVER_ARRIVING)
    if (['SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_ACCEPTED', 'DRIVER_ARRIVING'].includes(status)) {
      const driverLat = (driverTelemetry && driverTelemetry.lat) ? driverTelemetry.lat : (trip.driver ? trip.driver.currentLat : trip.pickupLat);
      const driverLng = (driverTelemetry && driverTelemetry.lng) ? driverTelemetry.lng : (trip.driver ? trip.driver.currentLng : trip.pickupLng);

      const pickupRoute = await this.calculateRoute(driverLat, driverLng, trip.pickupLat, trip.pickupLng, [], { vehicleId });
      
      return {
        success: true,
        orderId: trip.id,
        status,
        phase: 'PICKUP',
        driverId: trip.driver ? trip.driver.id : null,
        driverLocation: { lat: driverLat, lng: driverLng },
        targetAddress: trip.pickupAddress,
        distanceKm: pickupRoute.distanceKm,
        etaMinutes: pickupRoute.durationMin,
        provider: pickupRoute.provider,
        routeQuality: pickupRoute.routeQuality,
        isDegraded: Boolean(pickupRoute.isDegraded),
        lastUpdated: new Date().toISOString()
      };
    }

    // 2. At Pickup Phase (DRIVER_AT_PICKUP, PICKUP_CONFIRMED)
    if (['DRIVER_AT_PICKUP', 'PICKUP_CONFIRMED'].includes(status)) {
      const deliveryRoute = await this.calculateRoute(trip.pickupLat, trip.pickupLng, trip.dropLat, trip.dropLng, trip.intermediateStops || [], { vehicleId });

      return {
        success: true,
        orderId: trip.id,
        status,
        phase: 'AT_PICKUP',
        driverId: trip.driver ? trip.driver.id : null,
        targetAddress: trip.dropAddress,
        distanceKm: deliveryRoute.distanceKm,
        etaMinutes: 0,
        deliveryEtaMinutes: deliveryRoute.durationMin,
        provider: deliveryRoute.provider,
        routeQuality: deliveryRoute.routeQuality,
        isDegraded: Boolean(deliveryRoute.isDegraded),
        lastUpdated: new Date().toISOString()
      };
    }

    // 3. Delivery / In-Transit Phase (IN_TRANSIT, DRIVER_AT_DROPOFF)
    if (['IN_TRANSIT', 'DRIVER_AT_DROPOFF'].includes(status)) {
      const driverLat = (driverTelemetry && driverTelemetry.lat) ? driverTelemetry.lat : trip.pickupLat;
      const driverLng = (driverTelemetry && driverTelemetry.lng) ? driverTelemetry.lng : trip.pickupLng;

      const remainingRoute = await this.calculateRoute(driverLat, driverLng, trip.dropLat, trip.dropLng, [], { vehicleId });

      return {
        success: true,
        orderId: trip.id,
        status,
        phase: 'DELIVERY',
        driverId: trip.driver ? trip.driver.id : null,
        driverLocation: { lat: driverLat, lng: driverLng },
        targetAddress: trip.dropAddress,
        distanceKm: remainingRoute.distanceKm,
        etaMinutes: remainingRoute.durationMin,
        provider: remainingRoute.provider,
        routeQuality: remainingRoute.routeQuality,
        isDegraded: Boolean(remainingRoute.isDegraded),
        lastUpdated: new Date().toISOString()
      };
    }

    // 4. Terminated States (DELIVERED, CANCELLED, FAILED)
    return {
      success: true,
      orderId: trip.id,
      status,
      phase: 'TERMINATED',
      etaMinutes: 0,
      distanceKm: 0,
      lastUpdated: new Date().toISOString()
    };
  }

  getCacheStats() {
    return this.cache.getStats();
  }
}

const routingService = new RoutingService();

// Support legacy exports for backwards compatibility
function calculateRoute(pickupLat, pickupLng, dropLat, dropLng, intermediateStops = []) {
  return routingService.calculateRoute(pickupLat, pickupLng, dropLat, dropLng, intermediateStops);
}

module.exports = {
  RoutingService,
  routingService,
  haversineDistance,
  decodeGooglePolyline,
  isValidCoordinate,
  calculateRoute,
  VEHICLE_SPEED_PROFILES
};
