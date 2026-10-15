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
    super('HAVERSINE_FALLBACK');
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
  constructor(options = {}) {
    this.googleProvider = new GoogleRoutingProvider();
    this.osrmProvider = new OSRMProvider();
    this.fallbackProvider = new FallbackHaversineRoutingProvider();

    if (options.provider) {
      this.providers = [options.provider, this.fallbackProvider];
    } else if (Array.isArray(options.providers)) {
      this.providers = [...options.providers, this.fallbackProvider];
    } else {
      // Default provider priority chain
      this.providers = [
        this.googleProvider,
        this.osrmProvider,
        this.fallbackProvider
      ];
    }

    this.enableCache = options.enableCache !== false;
    this.cache = new RouteCache(options.cacheCapacity || 500, options.cacheTtlMs || 600000);

    // In-flight request deduplication map
    this.inFlightRequests = new Map();

    // Circuit Breaker State per Provider
    this.circuitBreakers = new Map();
    this.CIRCUIT_FAIL_THRESHOLD = options.circuitFailThreshold || 3;
    this.CIRCUIT_RESET_TIMEOUT_MS = options.circuitResetTimeoutMs || 30000;
  }

  getCircuitState(providerName) {
    if (!this.circuitBreakers.has(providerName)) {
      this.circuitBreakers.set(providerName, {
        state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
        failures: 0,
        lastFailureTime: 0
      });
    }
    const cb = this.circuitBreakers.get(providerName);
    if (cb.state === 'OPEN' && Date.now() - cb.lastFailureTime > this.CIRCUIT_RESET_TIMEOUT_MS) {
      cb.state = 'HALF_OPEN';
    }
    return cb;
  }

  recordCircuitSuccess(providerName) {
    const cb = this.getCircuitState(providerName);
    cb.failures = 0;
    cb.state = 'CLOSED';
  }

  recordCircuitFailure(providerName) {
    const cb = this.getCircuitState(providerName);
    cb.failures++;
    cb.lastFailureTime = Date.now();
    if (cb.failures >= this.CIRCUIT_FAIL_THRESHOLD) {
      if (cb.state !== 'OPEN') {
        metricsService.increment('routing_circuit_breaker_tripped_total');
      }
      cb.state = 'OPEN';
    }
  }

  /**
   * Validates external provider response against physical & mathematical anomalies
   */
  validateProviderResponse(result, waypoints, vehicleId = 'DEFAULT') {
    if (!result) return { valid: false, reason: 'Null or empty provider response' };
    
    const distanceKm = Number(result.distanceKm);
    const durationMin = Number(result.durationMin !== undefined ? result.durationMin : result.durationMinutes);

    if (!Number.isFinite(distanceKm) || distanceKm < 0) {
      return { valid: false, reason: `Invalid distanceKm: ${distanceKm}` };
    }
    if (!Number.isFinite(durationMin) || durationMin < 0) {
      return { valid: false, reason: `Invalid durationMin: ${durationMin}` };
    }

    // Great circle haversine between endpoints
    const start = waypoints[0];
    const end = waypoints[waypoints.length - 1];
    const straightLineKm = haversineDistance(start.lat, start.lng, end.lat, end.lng);

    // If straight line > 0.5km, road distance cannot be 0
    if (straightLineKm > 0.5 && distanceKm === 0) {
      return { valid: false, reason: `Zero distance for distinct coordinates (${straightLineKm.toFixed(2)}km straight)` };
    }

    // Circuity check: road distance cannot be significantly less than straight-line distance
    if (straightLineKm > 1.0 && distanceKm < straightLineKm * 0.8) {
      return { valid: false, reason: `Road distance (${distanceKm}km) violates Euclidean lower bound (${straightLineKm.toFixed(2)}km)` };
    }

    // Implausible Speed Anomaly: distance / (duration / 60) > 160 km/h in city
    if (distanceKm > 1.0 && durationMin > 0) {
      const calculatedSpeed = (distanceKm / (durationMin / 60));
      if (calculatedSpeed > 160) {
        return { valid: false, reason: `Implausible route speed detected: ${calculatedSpeed.toFixed(1)} km/h` };
      }
    }

    return { valid: true, distanceKm, durationMin };
  }

  /**
   * Primary Provider-Independent Route & Duration Calculation Method
   */
  async calculateRoute(arg1, arg2, arg3, arg4, arg5 = [], arg6 = {}) {
    let waypoints = [];
    let options = {};

    // Support polymorphic invocation:
    // Form A: calculateRoute(pickupLat, pickupLng, dropLat, dropLng, intermediateStops, options)
    // Form B: calculateRoute(waypointsArray, options)
    if (Array.isArray(arg1)) {
      waypoints = arg1.map(p => ({ lat: Number(p?.lat), lng: Number(p?.lng) }));
      options = arg2 || {};
    } else {
      const pickupLat = arg1;
      const pickupLng = arg2;
      const dropLat = arg3;
      const dropLng = arg4;
      const intermediateStops = Array.isArray(arg5) ? arg5 : [];
      options = arg6 || {};

      waypoints = [
        { lat: Number(pickupLat), lng: Number(pickupLng) },
        ...intermediateStops.map(stop => ({ lat: Number(stop?.lat), lng: Number(stop?.lng) })),
        { lat: Number(dropLat), lng: Number(dropLng) }
      ];
    }

    const routeStart = Date.now();
    metricsService.increment('routing_requests_total');
    metricsService.increment('eta_calculations_total');

    if (waypoints.length > 25) throw new RangeError('A route can contain at most 25 waypoints');
    if (waypoints.some(point => !isValidCoordinate(point.lat, point.lng))) {
      throw new RangeError('Every route waypoint must have valid latitude and longitude');
    }

    const vehicleId = options.vehicleId || 'DEFAULT';
    const isOutstation = Boolean(options.isOutstation);
    const requestedProviderName = options.provider;
    const bypassCache = Boolean(options.bypassCache) || !this.enableCache;

    // 1. Check Cache
    const cacheKey = this.cache.getCacheKey(waypoints, vehicleId, isOutstation, requestedProviderName);
    if (!bypassCache) {
      const cachedResult = this.cache.get(cacheKey);
      if (cachedResult) {
        metricsService.increment('routing_cache_hits_total');
        metricsService.recordLatency('routing_latency', Date.now() - routeStart);
        return {
          ...cachedResult,
          cached: true
        };
      }
      metricsService.increment('routing_cache_misses_total');
    }

    // 2. Request Deduplication for concurrent identical in-flight requests
    if (this.inFlightRequests.has(cacheKey)) {
      return await this.inFlightRequests.get(cacheKey);
    }

    const routeExecutionPromise = (async () => {
      // 3. Select Provider Chain
      let targetProviders = this.providers;
      if (requestedProviderName) {
        if (requestedProviderName === 'Google' || requestedProviderName === 'GoogleRoutingProvider') {
          targetProviders = [this.googleProvider, this.osrmProvider, this.fallbackProvider];
        } else if (requestedProviderName === 'OSRM' || requestedProviderName === 'OSRMProvider') {
          targetProviders = [this.osrmProvider, this.fallbackProvider];
        } else if (requestedProviderName === 'Fallback' || requestedProviderName === 'FallbackHaversineProvider' || requestedProviderName === 'HAVERSINE_FALLBACK') {
          targetProviders = [this.fallbackProvider];
        }
      }

      // 4. Execute Provider Fallback Loop with Circuit Breakers & Validation
      let attemptIndex = 0;
      for (const provider of targetProviders) {
        attemptIndex++;
        const providerName = provider.name;

        // Skip provider if Circuit Breaker is OPEN (unless it's the ultimate fallback)
        if (provider !== this.fallbackProvider) {
          const cb = this.getCircuitState(providerName);
          if (cb.state === 'OPEN') {
            continue;
          }
        }

        try {
          const result = await provider.calculateRoute(waypoints, { vehicleId, isOutstation });
          
          // Anomaly Validation Guard
          const validation = this.validateProviderResponse(result, waypoints, vehicleId);
          if (!validation.valid) {
            metricsService.increment('routing_anomalies_detected_total');
            metricsService.increment('routing_provider_failure_total');
            this.recordCircuitFailure(providerName);
            continue;
          }

          // Provider produced valid route
          this.recordCircuitSuccess(providerName);
          metricsService.increment('routing_provider_success_total');
          if (attemptIndex > 1 || result.isDegraded) {
            metricsService.increment('routing_fallback_total');
          }

          const finalResult = {
            distanceKm: validation.distanceKm,
            durationMin: validation.durationMin,
            durationMinutes: validation.durationMin,
            routePoints: result.routePoints || [],
            polyline: result.routePoints || [],
            provider: result.provider,
            source: result.provider,
            isDegraded: Boolean(result.isDegraded),
            routeQuality: result.routeQuality || (result.isDegraded ? 'ESTIMATED' : 'ROAD_NETWORK'),
            cached: false
          };

          // Save in cache
          if (this.enableCache) {
            this.cache.set(cacheKey, finalResult);
          }
          metricsService.recordLatency('routing_latency', Date.now() - routeStart);
          return finalResult;
        } catch (err) {
          this.recordCircuitFailure(providerName);
          metricsService.increment('routing_provider_failure_total');
        }
      }

      // 5. Ultimate Fallback: Internal Vehicle-Profile Haversine
      metricsService.increment('routing_fallback_total');
      const fallbackRes = await this.fallbackProvider.calculateRoute(waypoints, { vehicleId, isOutstation });
      metricsService.recordLatency('routing_latency', Date.now() - routeStart);
      const ultimateResult = {
        ...fallbackRes,
        durationMinutes: fallbackRes?.durationMin,
        polyline: fallbackRes?.routePoints || [],
        source: fallbackRes?.provider,
        cached: false
      };
      if (this.enableCache) {
        this.cache.set(cacheKey, ultimateResult);
      }
      return ultimateResult;
    })();

    this.inFlightRequests.set(cacheKey, routeExecutionPromise);
    try {
      return await routeExecutionPromise;
    } finally {
      this.inFlightRequests.delete(cacheKey);
    }
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
      pickupEtaMin: durationMin + 2, // +2 mins buffer for driver turnaround
      source: 'HAVERSINE_PROFILE'
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
