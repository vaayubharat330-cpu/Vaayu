import 'dart:async';
import 'driver_location_projection.dart';

/// Multi-trip high-frequency location projection store.
///
/// Location updates never modify trip state versions. Ordering is enforced by
/// server sequence when both sides provide one, otherwise by server timestamp
/// (falling back to client receive time).
class DriverLocationStore {
  final Map<String, DriverLocationProjection> _locations = {};
  final StreamController<DriverLocationProjection> _controller =
      StreamController<DriverLocationProjection>.broadcast();

  Stream<DriverLocationProjection> get locationsStream => _controller.stream;
  DriverLocationProjection? getLocation(String tripId) => _locations[tripId];
  Map<String, DriverLocationProjection> get snapshot => Map.unmodifiable(_locations);

  bool apply(DriverLocationProjection incoming) {
    final current = _locations[incoming.tripId];
    if (!incoming.isNewerThan(current)) return false;

    _locations[incoming.tripId] = incoming;
    _controller.add(incoming);
    return true;
  }

  void clear({String? tripId}) {
    if (tripId == null) {
      _locations.clear();
    } else {
      _locations.remove(tripId);
    }
  }

  Future<void> dispose() => _controller.close();
}
