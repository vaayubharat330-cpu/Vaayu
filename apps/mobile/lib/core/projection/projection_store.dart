import 'dart:async';
import 'local_trip_projection.dart';

/// Multi-entity authoritative trip projection store.
///
/// Invariants:
/// 1. Each trip is versioned independently.
/// 2. incomingVersion > localVersion -> apply.
/// 3. incomingVersion <= localVersion -> discard.
/// 4. REST snapshots and WebSocket state events share this reconciliation path.
class ProjectionStore {
  final Map<String, LocalTripProjection> _trips = {};
  final List<void Function(LocalTripProjection)> _listeners = [];
  final StreamController<LocalTripProjection> _projectionsController =
      StreamController<LocalTripProjection>.broadcast();

  // Backward-compatible view for existing consumers that track one active trip.
  String? _lastTouchedTripId;

  LocalTripProjection? get currentTrip =>
      _lastTouchedTripId == null ? null : _trips[_lastTouchedTripId];

  Stream<LocalTripProjection> get projectionsStream => _projectionsController.stream;

  Iterable<String> get tripIds => _trips.keys;

  Map<String, LocalTripProjection> get snapshot => Map.unmodifiable(_trips);

  LocalTripProjection? getProjection(String tripId) => _trips[tripId];

  bool applyAuthoritativeSnapshot(LocalTripProjection snapshot) => applyUpdate(snapshot);

  void addListener(void Function(LocalTripProjection) listener) => _listeners.add(listener);

  void removeListener(void Function(LocalTripProjection) listener) => _listeners.remove(listener);

  bool applyUpdate(LocalTripProjection incoming) {
    final current = _trips[incoming.tripId];
    if (current != null && incoming.version <= current.version) {
      return false;
    }

    _trips[incoming.tripId] = incoming;
    _lastTouchedTripId = incoming.tripId;
    _notify(incoming);
    return true;
  }

  void clear({String? tripId}) {
    if (tripId == null) {
      _trips.clear();
      _lastTouchedTripId = null;
      return;
    }

    _trips.remove(tripId);
    if (_lastTouchedTripId == tripId) {
      _lastTouchedTripId = _trips.isEmpty ? null : _trips.keys.last;
    }
  }

  void _notify(LocalTripProjection projection) {
    for (final listener in List<void Function(LocalTripProjection)>.from(_listeners)) {
      listener(projection);
    }
    _projectionsController.add(projection);
  }

  Future<void> dispose() => _projectionsController.close();
}

typedef LocalTripProjectionStore = ProjectionStore;
