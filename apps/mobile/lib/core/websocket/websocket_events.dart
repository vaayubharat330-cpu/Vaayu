import '../projection/local_trip_projection.dart';

sealed class WebSocketEvent {
  const WebSocketEvent();
}

class TripStateUpdateEvent extends WebSocketEvent {
  final LocalTripProjection projection;
  const TripStateUpdateEvent(this.projection);
}

class DriverLocationPingEvent extends WebSocketEvent {
  final String tripId;
  final double latitude;
  final double longitude;
  final double? accuracyMeters;
  final DateTime? timestamp;
  final int? sequence;

  const DriverLocationPingEvent({
    required this.tripId,
    required this.latitude,
    required this.longitude,
    this.accuracyMeters,
    this.timestamp,
    this.sequence,
  });
}

class OfferDispatchedEvent extends WebSocketEvent {
  final Map<String, dynamic> payload;
  const OfferDispatchedEvent(this.payload);
}

class PongEvent extends WebSocketEvent {
  const PongEvent();
}

class UnknownWebSocketEvent extends WebSocketEvent {
  final String type;
  final Map<String, dynamic> payload;
  const UnknownWebSocketEvent(this.type, this.payload);
}
