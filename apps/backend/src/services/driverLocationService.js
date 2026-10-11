const { getActiveDriverLocationStore, calcHaversine } = require('./driverLocationStore');

/**
 * VAAYU Production-Hardened Driver GPS & Telemetry Engine (V2)
 * 
 * Features & Hardening:
 * 1. Multi-Tier Liveness State Machine (ONLINE 0-15s, DEGRADED 15-30s, STALE 30-60s, OFFLINE >60s)
 * 2. Replay & Out-Of-Order Telemetry Protection (timestamp validation against replay attacks)
 * 3. Stationary Bearing Stabilization (preserves heading when displacement < 5m to prevent spinning)
 * 4. Modular Storage Adapter (InMemoryDriverLocationStore / RedisDriverLocationStore)
 * 5. Trip Active Protection (Does NOT terminate active delivery state on temporary telemetry loss)
 */
class DriverLocationService {
  constructor(store = null) {
    this.store = store || getActiveDriverLocationStore();

    // Configurable Liveness Thresholds (seconds)
    this.LIVENESS_CONFIG = {
      DEGRADED_THRESHOLD_SEC: 15,
      STALE_THRESHOLD_SEC: 30,
      OFFLINE_THRESHOLD_SEC: 60
    };

    // Configurable Glitch Thresholds
    this.MAX_REALISTIC_SPEED_KMH = 130;
    this.MAX_ALLOWED_FUTURE_MS = 5000;   // Reject pings >5s in future
    this.MAX_ALLOWED_PAST_MS = 300000;   // Reject pings >5 min in past
    this.STATIONARY_DISTANCE_KM = 0.005; // 5 meters threshold for bearing updates
  }

  /**
   * Validates raw GPS telemetry data and protects against out-of-order & replayed packets
   */
  validateTelemetry(rawLat, rawLng, rawSpeed = 0, rawAccuracy = 10, rawTimestamp = null, existing = null) {
    const lat = parseFloat(rawLat);
    const lng = parseFloat(rawLng);
    const speed = parseFloat(rawSpeed) || 0;
    const accuracy = parseFloat(rawAccuracy) || 5;

    // 1. Basic coordinate range checks
    if (isNaN(lat) || isNaN(lng)) return { valid: false, reason: 'NaN coordinates' };
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { valid: false, reason: 'Coordinates out of bounds' };
    if (lat === 0 && lng === 0) return { valid: false, reason: 'Zero null island coordinates' };

    // 2. High GPS error radius (> 100m accuracy circle is untrusted)
    if (accuracy > 100) return { valid: false, reason: `Low GPS accuracy (${accuracy}m)` };

    // 3. Timestamp Replay & Stale Checks
    const now = Date.now();
    const pingTimestampMs = parseInt(rawTimestamp || now, 10);

    if (isNaN(pingTimestampMs)) return { valid: false, reason: 'Invalid timestamp format' };
    if (pingTimestampMs > now + this.MAX_ALLOWED_FUTURE_MS) return { valid: false, reason: 'Future timestamp detected' };
    if (pingTimestampMs < now - this.MAX_ALLOWED_PAST_MS) return { valid: false, reason: 'Stale/expired timestamp detected' };

    // Replay Protection: Reject strictly older out-of-order telemetry packets
    if (existing && existing.lastPingMs && pingTimestampMs < existing.lastPingMs) {
      return { valid: false, reason: 'Replayed or out-of-order telemetry packet rejected' };
    }

    return { valid: true, lat, lng, speed, accuracy, pingTimestampMs };
  }

  /**
   * Evaluates multi-tier driver liveness state from ping age
   */
  getLivenessState(lastPingMs) {
    if (!lastPingMs) return 'OFFLINE';
    const ageSec = (Date.now() - lastPingMs) / 1000;

    if (ageSec > this.LIVENESS_CONFIG.OFFLINE_THRESHOLD_SEC) return 'OFFLINE';
    if (ageSec > this.LIVENESS_CONFIG.STALE_THRESHOLD_SEC) return 'STALE';
    if (ageSec > this.LIVENESS_CONFIG.DEGRADED_THRESHOLD_SEC) return 'DEGRADED';
    return 'ONLINE';
  }

  /**
   * Ingests a new GPS location ping from a driver client
   */
  async updateDriverLocation(driverId, telemetryData) {
    const rawLat = telemetryData.lat !== undefined ? telemetryData.lat : telemetryData.latitude;
    const rawLng = telemetryData.lng !== undefined ? telemetryData.lng : telemetryData.longitude;
    const { bearing = 0, speed = 0, accuracy = 5, timestamp = null, status = 'ONLINE', tripId = null } = telemetryData;

    // Retrieve existing driver state
    const existing = await this.store.getDriverLocation(driverId);

    // Validate Telemetry & Timestamp
    const validation = this.validateTelemetry(rawLat, rawLng, speed, accuracy, timestamp, existing);
    if (!validation.valid) {
      console.warn(`[DriverLocationService] Ping rejected for ${driverId}: ${validation.reason}`);
      return { success: false, reason: validation.reason };
    }

    const now = validation.pingTimestampMs;

    // Telemetry Jump Glitch Filter
    if (existing && existing.lat && existing.lng && existing.lastPingMs) {
      const timeDeltaSec = Math.max(0.1, (now - existing.lastPingMs) / 1000);
      const distanceKm = calcHaversine(existing.lat, existing.lng, validation.lat, validation.lng);
      const calculatedSpeedKmh = (distanceKm / timeDeltaSec) * 3600;

      if (!telemetryData.bypassSpeedFilter && calculatedSpeedKmh > this.MAX_REALISTIC_SPEED_KMH && distanceKm > 0.5) {
        console.warn(`[DriverLocationService] Telemetry speed jump rejected for ${driverId}: ${calculatedSpeedKmh.toFixed(1)} km/h`);
        return { success: false, reason: 'Impossible GPS position jump (speed anomaly)' };
      }
    }

    // Stationary Bearing Stabilization: Only update heading if movement displacement >= 5 meters
    let finalBearing = parseFloat(bearing) || 0;
    let bearingConfidence = 'HARDWARE_COMPASS';

    if (existing && existing.lat && existing.lng) {
      const moveDistanceKm = calcHaversine(existing.lat, existing.lng, validation.lat, validation.lng);
      if (moveDistanceKm < this.STATIONARY_DISTANCE_KM) {
        // Vehicle is stationary or moving under 5m: lock heading to previous bearing
        finalBearing = existing.bearing || 0;
        bearingConfidence = 'STATIONARY_HOLD';
      } else if (!bearing) {
        finalBearing = this.calculateBearing(existing.lat, existing.lng, validation.lat, validation.lng);
        bearingConfidence = 'CALCULATED_DELTA';
      }
    }

    const effectiveLiveness = 'ONLINE';
    const usableIdentityValue = value => {
      if (value === undefined || value === null) return false;
      const normalized = String(value).trim();
      return normalized.length > 0 && !/^(undefined|null)$/i.test(normalized);
    };

    const updatedRecord = {
      driverId,
      name: usableIdentityValue(telemetryData.name)
        ? String(telemetryData.name).trim()
        : (usableIdentityValue(existing?.name) ? existing.name : `Driver ${driverId}`),
      phone: usableIdentityValue(telemetryData.phone)
        ? String(telemetryData.phone).trim()
        : (usableIdentityValue(existing?.phone) ? existing.phone : ''),
      vehicleId: telemetryData.vehicleId || (existing ? existing.vehicleId : 'v_ace'),
      lat: validation.lat,
      lng: validation.lng,
      bearing: Math.round(finalBearing),
      bearingConfidence,
      speed: validation.speed,
      accuracy: validation.accuracy,
      status: tripId ? 'ON_TRIP' : (status || 'ONLINE'),
      livenessState: effectiveLiveness,
      currentTripId: tripId || (existing ? existing.currentTripId : null),
      lastPingMs: now,
      updatedAt: new Date(now).toISOString()
    };

    // Save to Store Abstraction
    await this.store.saveDriverLocation(driverId, updatedRecord);

    // Append to Location Audit History Log
    await this.store.appendHistory(driverId, {
      lat: validation.lat,
      lng: validation.lng,
      bearing: Math.round(finalBearing),
      speed: validation.speed,
      tripId: updatedRecord.currentTripId,
      timestampMs: now,
      isoTime: new Date(now).toISOString()
    });

    return {
      success: true,
      driver: updatedRecord
    };
  }

  /**
   * Spatial search for nearby available drivers within radius (GEORADIUS Proxy)
   */
  async findNearbyDrivers(lat, lng, radiusKm = 10, vehicleId = null) {
    return await this.store.findNearbyDrivers(lat, lng, radiusKm, vehicleId);
  }

  /**
   * Gets driver current state with multi-tier liveness evaluation
   */
  async getDriverState(driverId) {
    const driver = await this.store.getDriverLocation(driverId);
    if (!driver) return null;

    const livenessState = this.getLivenessState(driver.lastPingMs);
    return {
      ...driver,
      livenessState,
      isDispatchEligible: (livenessState === 'ONLINE' || livenessState === 'DEGRADED') && driver.status !== 'OFFLINE' && !driver.currentTripId
    };
  }

  /**
   * Retrieves driver location history
   */
  async getDriverHistory(driverId, tripId = null) {
    return await this.store.getDriverHistory(driverId, tripId);
  }

  /**
   * Sets driver online/offline availability
   */
  async clearDriverLocation(driverId) {
    if (this.store.clearDriverLocation) {
      await this.store.clearDriverLocation(driverId);
    }
  }

  async setDriverAvailability(driverId, isOnline) {

    return await this.store.setDriverAvailability(driverId, isOnline);
  }

  /**
   * Utility to compute compass bearing angle (0-360 degrees) between two points
   */
  calculateBearing(lat1, lon1, lat2, lon2) {
    const toRad = deg => (deg * Math.PI) / 180;
    const toDeg = rad => (rad * 180) / Math.PI;

    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const deltaLambda = toRad(lon2 - lon1);

    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

    const theta = Math.atan2(y, x);
    return (toDeg(theta) + 360) % 360;
  }
}

const driverLocationService = new DriverLocationService();

module.exports = {
  DriverLocationService,
  driverLocationService
};
