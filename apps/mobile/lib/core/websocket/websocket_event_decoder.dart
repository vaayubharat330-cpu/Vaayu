import 'websocket_events.dart';
import '../projection/local_trip_projection.dart';

/// Converts wire-level JSON into typed events. It intentionally contains no
/// business decisions; backend payloads remain authoritative.
class WebSocketEventDecoder {
  const WebSocketEventDecoder();

  WebSocketEvent decode(Map<String, dynamic> frame) {
    final type = _string(frame['type']) ??
        _string(frame['event']) ??
        _string(frame['action']) ??
        '';

    switch (type) {
      case 'trip_state_update':
      case 'order_updated':
      case 'trip_updated':
        return TripStateUpdateEvent(
          LocalTripProjection.fromJson(_map(frame['trip']) ??
              _map(frame['data']) ??
              _map(frame['payload']) ??
              frame),
        );
      case 'driver_location_ping':
        final payload = _map(frame['data']) ??
            _map(frame['payload']) ??
            frame;
        return DriverLocationPingEvent(
          tripId: _requiredString(payload, const ['tripId', 'trip_id', 'orderId']),
          latitude: _requiredDouble(payload, const ['lat', 'latitude', 'driverLat']),
          longitude: _requiredDouble(payload, const ['lng', 'lon', 'longitude', 'driverLng']),
          accuracyMeters: _optionalDouble(
            payload,
            const ['accuracy', 'accuracyMeters', 'accuracy_meters'],
          ),
          timestamp: _optionalDateTime(payload, const ['timestamp', 'updatedAt', 'sentAt']),
          sequence: _optionalInt(payload, const ['sequence', 'seq']),
        );
      case 'offer_dispatched':
        return OfferDispatchedEvent(
          _map(frame['data']) ?? _map(frame['payload']) ?? frame,
        );
      case 'pong':
        return const PongEvent();
      default:
        return UnknownWebSocketEvent(type, frame);
    }
  }

  Map<String, dynamic>? _map(dynamic value) {
    if (value is Map) return Map<String, dynamic>.from(value);
    return null;
  }

  String? _string(dynamic value) => value is String && value.isNotEmpty ? value : null;

  String _requiredString(Map<String, dynamic> data, List<String> keys) {
    for (final key in keys) {
      final value = _string(data[key]);
      if (value != null) return value;
    }
    throw const FormatException('WebSocket event missing required string field');
  }

  double _requiredDouble(Map<String, dynamic> data, List<String> keys) {
    for (final key in keys) {
      final value = data[key];
      if (value is num) return value.toDouble();
    }
    throw const FormatException('WebSocket event missing required numeric field');
  }

  double? _optionalDouble(Map<String, dynamic> data, List<String> keys) {
    for (final key in keys) {
      final value = data[key];
      if (value is num) return value.toDouble();
    }
    return null;
  }

  int? _optionalInt(Map<String, dynamic> data, List<String> keys) {
    for (final key in keys) {
      final value = data[key];
      if (value is int) return value;
      if (value is num) return value.toInt();
    }
    return null;
  }

  DateTime? _optionalDateTime(Map<String, dynamic> data, List<String> keys) {
    for (final key in keys) {
      final value = data[key];
      if (value is String) return DateTime.tryParse(value);
      if (value is int) return DateTime.fromMillisecondsSinceEpoch(value, isUtc: true);
    }
    return null;
  }
}
