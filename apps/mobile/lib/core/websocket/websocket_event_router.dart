import 'dart:async';

import '../projection/driver_location_projection.dart';
import '../projection/driver_location_store.dart';
import '../projection/offer_projection.dart';
import '../projection/offer_store.dart';
import '../projection/projection_store.dart';
import 'websocket_event_decoder.dart';
import 'websocket_events.dart';

/// Fan-out boundary between transport frames and application projections.
///
/// REST snapshots and WebSocket trip-state events both enter ProjectionStore,
/// preserving one reconciliation path. High-frequency driver location events
/// deliberately remain on a separate stream and are NOT applied to the trip
/// version projection in Phase A.
class WebSocketEventRouter {
  final ProjectionStore _projectionStore;
  final WebSocketEventDecoder _decoder;
  final DriverLocationStore _locationStore;
  final OfferStore _offerStore;

  final StreamController<DriverLocationPingEvent> _locationController =
      StreamController<DriverLocationPingEvent>.broadcast();
  final StreamController<OfferDispatchedEvent> _offerController =
      StreamController<OfferDispatchedEvent>.broadcast();
  final StreamController<WebSocketEvent> _eventController =
      StreamController<WebSocketEvent>.broadcast();
  final StreamController<UnknownWebSocketEvent> _unknownController =
      StreamController<UnknownWebSocketEvent>.broadcast();

  WebSocketEventRouter({
    required ProjectionStore projectionStore,
    WebSocketEventDecoder decoder = const WebSocketEventDecoder(),
    DriverLocationStore? locationStore,
    OfferStore? offerStore,
  })  : _projectionStore = projectionStore,
        _decoder = decoder,
        _locationStore = locationStore ?? DriverLocationStore(),
        _offerStore = offerStore ?? OfferStore();

  Stream<DriverLocationPingEvent> get locationStream => _locationController.stream;
  Stream<OfferDispatchedEvent> get offerStream => _offerController.stream;
  Stream<WebSocketEvent> get eventStream => _eventController.stream;
  Stream<UnknownWebSocketEvent> get unknownStream => _unknownController.stream;
  DriverLocationStore get locationStore => _locationStore;
  OfferStore get offerStore => _offerStore;

  /// Returns true when the frame was decoded and routed to a known consumer.
  bool routeFrame(Map<String, dynamic> frame) {
    try {
      final event = _decoder.decode(frame);
      _eventController.add(event);

      switch (event) {
        case TripStateUpdateEvent(:final projection):
          return _projectionStore.applyUpdate(projection);
        case DriverLocationPingEvent():
          final applied = _locationStore.apply(
            DriverLocationProjection(
              tripId: event.tripId,
              latitude: event.latitude,
              longitude: event.longitude,
              accuracyMeters: event.accuracyMeters,
              receivedAt: DateTime.now().toUtc(),
              serverTimestamp: event.timestamp,
              sequence: event.sequence,
            ),
          );
          if (applied) _locationController.add(event);
          return applied;
        case OfferDispatchedEvent():
          final receivedAt = DateTime.now().toUtc();
          final offerId = _string(event.payload, const ['offerId', 'id']) ??
              '${event.payload['orderId'] ?? 'offer'}-$receivedAt';
          final orderId = _string(event.payload, const ['orderId', 'tripId', 'id']) ?? '';
          final expiresAt = _date(event.payload, const ['expiresAt', 'expires_at']);
          final serverTime = _date(
            event.payload,
            const ['serverTime', 'serverTimestamp', 'server_time'],
          );
          _offerStore.upsert(
            OfferProjection(
              offerId: offerId,
              orderId: orderId,
              payload: Map<String, dynamic>.unmodifiable(event.payload),
              receivedAt: receivedAt,
              expiresAt: expiresAt,
              serverTimeAtReceipt: serverTime,
            ),
          );
          _offerController.add(event);
          return true;
        case PongEvent():
          return true;
        case UnknownWebSocketEvent():
          _unknownController.add(event);
          return false;
      }
    } on FormatException {
      return false;
    }
  }

  String? _string(Map<String, dynamic> data, List<String> keys) {
    for (final key in keys) {
      final value = data[key];
      if (value is String && value.isNotEmpty) return value;
    }
    return null;
  }

  DateTime? _date(Map<String, dynamic> data, List<String> keys) {
    for (final key in keys) {
      final value = data[key];
      if (value is String) return DateTime.tryParse(value)?.toUtc();
      if (value is int) return DateTime.fromMillisecondsSinceEpoch(value, isUtc: true);
    }
    return null;
  }

  Future<void> dispose() async {
    await _locationController.close();
    await _offerController.close();
    await _eventController.close();
    await _unknownController.close();
    await _locationStore.dispose();
    await _offerStore.dispose();
  }
}
