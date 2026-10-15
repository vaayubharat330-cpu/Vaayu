const { getActiveDriverLocationStore, calcHaversine } = require('./driverLocationStore');

/**
 * VAAYU Production-Hardened Driver GPS & Telemetry Engine (V2)
 *
 * Features & Hardening:
 * 1. Phase-2 liveness: HEALTHY/DEGRADED within 0-5s/5-15s, STALE 15-60s, OFFLINE >60s.
 * 2. Device packet-age validation against server receipt time, not an inferred server clock.
 * 3. Monotonic sequence protection for duplicate/out-of-order telemetry packets.
 * 4. Replay protection and physical jump/glitch filtering.
 * 5. Trip active protection: telemetry loss never terminates an active delivery state.
 */
class DriverLocationService {
  constructor(store = null) {
    this.store = store || getActiveDriverLocationStore();

    this.LIVENESS_CONFIG = {
      HEALTHY_THRESHOLD_SEC: 5,
      DEGRADED_THRESHOLD_SEC: 15,
      STALE_THRESHOLD_SEC: 60,
      OFFLINE_THRESHOLD_SEC: 60
    };

    this.MAX_REALISTIC_SPEED_KMH = 130;
    this.MAX_ALLOWED_FUTURE_MS = 5000;
    this.MAX_ALLOWED_PAST_MS = 300000;
    this.STATIONARY_DISTANCE_KM = 0.005;
  }

  normalizeTimestamp(rawTimestamp, fallbackMs) {
    if (rawTimestamp === undefined || rawTimestamp === null || rawTimestamp === '') return fallbackMs;
    const numeric = Number(rawTimestamp);
    if (!Number.isFinite(numeric)) return NaN;
    // Accept Unix seconds from mobile SDKs as well as Unix milliseconds.
    return numeric < 100000000000 ? Math.round(numeric * 1000) : Math.round(numeric);
  }

  validateTelemetry(rawLat, rawLng, rawSpeed = 0, rawAccuracy = 10, rawTimestamp = null, existing = null, serverReceivedAt = Date.now(), rawSequence = null) {
    const lat = parseFloat(rawLat);
    const lng = parseFloat(rawLng);
    const speed = parseFloat(rawSpeed) || 0;
    const accuracy = parseFloat(rawAccuracy) || 5;

    if (isNaN(lat) || isNaN(lng)) return { valid: false, reason: 'NaN coordinates' };
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { valid: false, reason: 'Coordinates out of bounds' };
    if (lat === 0 && lng === 0) return { valid: false, reason: 'Zero null island coordinates' };
    if (accuracy > 100) return { valid: false, reason: `Low GPS accuracy (${accuracy}m)` };

    const pingTimestampMs = this.normalizeTimestamp(rawTimestamp, serverReceivedAt);
    if (!Number.isFinite(pingTimestampMs)) return { valid: false, reason: 'Invalid timestamp format' };
    if (pingTimestampMs > serverReceivedAt + this.MAX_ALLOWED_FUTURE_MS) return { valid: false, reason: 'Future timestamp detected' };
    if (pingTimestampMs < serverReceivedAt - this.MAX_ALLOWED_PAST_MS) return { valid: false, reason: 'Stale/expired timestamp detected' };

    const sequence = rawSequence === undefined || rawSequence === null || rawSequence === '' ? null : Number(rawSequence);
    if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0)) {
      return { valid: false, reason: 'Invalid telemetry sequence' };
    }
    if (existing && sequence !== null && Number.isSafeInteger(existing.lastSequence) && sequence <= existing.lastSequence) {
      return { valid: false, reason: sequence === existing.lastSequence ? 'Duplicate telemetry sequence rejected' : 'Replayed or out-of-order telemetry sequence rejected' };
    }
    if (existing && existing.lastPingMs && pingTimestampMs < existing.lastPingMs) {
      return { valid: false, reason: 'Replayed or out-of-order telemetry packet rejected' };
    }

    return { valid: true, lat, lng, speed, accuracy, pingTimestampMs, sequence, serverReceivedAt };
  }

  getLivenessState(lastServerReceivedAt, lastPingMs = null) {
    if (!lastServerReceivedAt && !lastPingMs) return 'OFFLINE';
    const referenceMs = lastServerReceivedAt || lastPingMs;
    const ageSec = Math.max(0, (Date.now() - referenceMs) / 1000);

    if (ageSec > this.LIVENESS_CONFIG.OFFLINE_THRESHOLD_SEC) return 'OFFLINE';
    if (ageSec > this.LIVENESS_CONFIG.DEGRADED_THRESHOLD_SEC) return 'STALE';
    if (ageSec > this.LIVENESS_CONFIG.HEALTHY_THRESHOLD_SEC) return 'DEGRADED';
    return 'HEALTHY';
  }

  async updateDriverLocation(driverId, telemetryData) {
    const serverReceivedAt = Date.now();
    const rawLat = telemetryData.lat !== undefined ? telemetryData.lat : telemetryData.latitude;
    const rawLng = telemetryData.lng !== undefined ? telemetryData.lng : telemetryData.longitude;
    const {
      bearing = 0,
      speed = 0,
      accuracy = 5,
      timestamp = null,
      deviceGeneratedAt = timestamp,
      sequence = telemetryData.seq ?? telemetryData.sequence ?? null,
      status = 'ONLINE',
      tripId = null
    } = telemetryData;

    const existing = await this.store.getDriverLocation(driverId);
    const validation = this.validateTelemetry(rawLat, rawLng, speed, accuracy, deviceGeneratedAt, existing, serverReceivedAt, sequence);
    if (!validation.valid) {
      console.warn(`[DriverLocationService] Ping rejected for ${driverId}: ${validation.reason}`);
      return { success: false, reason: validation.reason };
    }

    const deviceGeneratedMs = validation.pingTimestampMs;
    const packetAgeMs = Math.max(0, serverReceivedAt - deviceGeneratedMs);

    if (existing && existing.lat && existing.lng && existing.lastPingMs) {
      const timeDeltaSec = Math.max(0.1, (deviceGeneratedMs - existing.lastPingMs) / 1000);
      const distanceKm = calcHaversine(existing.lat, existing.lng, validation.lat, validation.lng);
      const calculatedSpeedKmh = (distanceKm / timeDeltaSec) * 3600;
      if (!telemetryData.bypassSpeedFilter && calculatedSpeedKmh > this.MAX_REALISTIC_SPEED_KMH && distanceKm > 0.5) {
        console.warn(`[DriverLocationService] Telemetry speed jump rejected for ${driverId}: ${calculatedSpeedKmh.toFixed(1)} km/h`);
        return { success: false, reason: 'Impossible GPS position jump (speed anomaly)' };
      }
    }

    let finalBearing = parseFloat(bearing) || 0;
    let bearingConfidence = 'HARDWARE_COMPASS';
    if (existing && existing.lat && existing.lng) {
      const moveDistanceKm = calcHaversine(existing.lat, existing.lng, validation.lat, validation.lng);
      if (moveDistanceKm < this.STATIONARY_DISTANCE_KM) {
        finalBearing = existing.bearing || 0;
        bearingConfidence = 'STATIONARY_HOLD';
      } else if (!bearing) {
        finalBearing = this.calculateBearing(existing.lat, existing.lng, validation.lat, validation.lng);
        bearingConfidence = 'CALCULATED_DELTA';
      }
    }

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
      livenessState: 'HEALTHY',
      currentTripId: tripId || (existing ? existing.currentTripId : null),
      lastPingMs: deviceGeneratedMs,
      lastServerReceivedAt: serverReceivedAt,
      packetAgeMs,
      lastSequence: validation.sequence !== null ? validation.sequence : (existing?.lastSequence ?? null),
      updatedAt: new Date(serverReceivedAt).toISOString()
    };

    await this.store.saveDriverLocation(driverId, updatedRecord);
    await this.store.appendHistory(driverId, {
      lat: validation.lat,
      lng: validation.lng,
      bearing: Math.round(finalBearing),
      speed: validation.speed,
      tripId: updatedRecord.currentTripId,
      sequence: validation.sequence,
      deviceGeneratedAt: new Date(deviceGeneratedMs).toISOString(),
      serverReceivedAt: new Date(serverReceivedAt).toISOString(),
      packetAgeMs,
      timestampMs: deviceGeneratedMs,
      isoTime: new Date(serverReceivedAt).toISOString()
    });

    return { success: true, driver: updatedRecord };
  }

  async findNearbyDrivers(lat, lng, radiusKm = 10, vehicleId = null) {
    return await this.store.findNearbyDrivers(lat, lng, radiusKm, vehicleId);
  }

  async getDriverState(driverId) {
    const driver = await this.store.getDriverLocation(driverId);
    if (!driver) return null;

    const livenessState = this.getLivenessState(driver.lastServerReceivedAt, driver.lastPingMs);
    return {
      ...driver,
      livenessState,
      isDispatchEligible: (livenessState === 'HEALTHY' || livenessState === 'DEGRADED') && driver.status !== 'OFFLINE' && !driver.currentTripId
    };
  }

  async getDriverHistory(driverId, tripId = null) {
    return await this.store.getDriverHistory(driverId, tripId);
  }

  async clearDriverLocation(driverId) {
    if (this.store.clearDriverLocation) await this.store.clearDriverLocation(driverId);
  }

  async setDriverAvailability(driverId, isOnline) {
    return await this.store.setDriverAvailability(driverId, isOnline);
  }

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

module.exports = { DriverLocationService, driverLocationService };