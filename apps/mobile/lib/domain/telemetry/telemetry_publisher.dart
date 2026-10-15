/// Driver Location & Telemetry Publisher.
/// Enforces client-side coordinate sanity checks, distance-based throttling,
/// and periodic telemetry heartbeat transmission to the backend.
library telemetry_publisher;

import 'dart:async';
import 'dart:math' as math;
import '../../core/network/api_client.dart';
import '../../core/websocket/websocket_client.dart';

class LocationPoint {
  final double lat;
  final double lng;
  final double? heading;
  final double? speed;
  final double? accuracy;
  final DateTime timestamp;

  const LocationPoint({
    required this.lat,
    required this.lng,
    this.heading,
    this.speed,
    this.accuracy,
    required this.timestamp,
  });

  Map<String, dynamic> toJson() {
    return {
      'lat': lat,
      'lng': lng,
      if (heading != null) 'heading': heading,
      if (speed != null) 'speed': speed,
      if (accuracy != null) 'accuracy': accuracy,
      'timestamp': timestamp.toIso8601String(),
    };
  }

  /// Calculates approximate Haversine distance in meters to another point.
  double distanceTo(LocationPoint other) {
    const earthRadius = 6371000.0; // meters
    final dLat = (other.lat - lat) * (math.pi / 180.0);
    final dLng = (other.lng - lng) * (math.pi / 180.0);
    final a = math.sin(dLat / 2) * math.sin(dLat / 2) +
        math.cos(lat * (math.pi / 180.0)) *
            math.cos(other.lat * (math.pi / 180.0)) *
            math.sin(dLng / 2) *
            math.sin(dLng / 2);
    final c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
    return earthRadius * c;
  }
}

class TelemetryPublisher {
  final ApiClient _apiClient;
  final WebSocketClient? _wsClient;
  final Duration minThrottleInterval;
  final double minDistanceMeters;

  LocationPoint? _lastPublishedPoint;
  DateTime? _lastPublishedTime;
  bool _isPublishing = false;

  TelemetryPublisher({
    required ApiClient apiClient,
    WebSocketClient? wsClient,
    this.minThrottleInterval = const Duration(seconds: 3),
    this.minDistanceMeters = 10.0,
  })  : _apiClient = apiClient,
        _wsClient = wsClient;

  LocationPoint? get lastPublishedPoint => _lastPublishedPoint;

  /// Validates and publishes a GPS coordinate ping to backend.
  /// Throttles transmissions if the update is within throttle intervals unless
  /// distance moved exceeds minDistanceMeters.
  Future<bool> publishLocation({
    required String driverId,
    required double lat,
    required double lng,
    double? heading,
    double? speed,
    double? accuracy,
    String? currentTripId,
  }) async {
    // 1. Sanity check latitude and longitude coordinates
    if (!lat.isFinite || !lng.isFinite || lat.abs() > 90.0 || lng.abs() > 180.0) {
      return false; // Silently reject malformed telemetry coordinates
    }

    // 2. Reject points with unreasonable GPS accuracy error (> 100 meters)
    if (accuracy != null && accuracy > 100.0) {
      return false;
    }

    final newPoint = LocationPoint(
      lat: lat,
      lng: lng,
      heading: heading,
      speed: speed,
      accuracy: accuracy,
      timestamp: DateTime.now(),
    );

    // 3. Throttle evaluation
    if (_lastPublishedPoint != null && _lastPublishedTime != null) {
      final elapsed = DateTime.now().difference(_lastPublishedTime!);
      final distanceMoved = _lastPublishedPoint!.distanceTo(newPoint);

      if (elapsed < minThrottleInterval && distanceMoved < minDistanceMeters) {
        // Discard update: within throttle window and has not moved significantly
        return false;
      }
    }

    if (_isPublishing) return false;
    _isPublishing = true;

    try {
      final payload = {
        'driverId': driverId,
        'lat': lat,
        'lng': lng,
        if (heading != null) 'heading': heading,
        if (speed != null) 'speed': speed,
        if (accuracy != null) 'accuracy': accuracy,
        if (currentTripId != null) 'tripId': currentTripId,
        'timestamp': newPoint.timestamp.toIso8601String(),
      };

      // Send over active WebSocket if available, otherwise fallback to HTTP
      if (_wsClient != null && _wsClient!.isConnected) {
        _wsClient!.send({
          'type': 'driver_location_ping',
          'data': payload,
        });
      } else {
        await _apiClient.post(
          '/api/driver/location/update',
          body: payload,
        );
      }

      _lastPublishedPoint = newPoint;
      _lastPublishedTime = DateTime.now();
      return true;
    } catch (_) {
      return false;
    } finally {
      _isPublishing = false;
    }
  }

  void reset() {
    _lastPublishedPoint = null;
    _lastPublishedTime = null;
    _isPublishing = false;
  }
}
