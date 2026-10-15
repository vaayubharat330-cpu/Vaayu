import 'dart:async';
import '../persistence/local_persistence_service.dart';
import '../projection/local_trip_projection.dart';
import '../projection/projection_store.dart';

/// Resync Coordinator
/// Invariants Enforced:
/// 1. Re-anchors client projection to authoritative server truth on foreground resume.
/// 2. Multiple concurrent foreground signals coalesce into ONE in-flight resync request.
/// 3. Resync and pending queue operations are mutually sequenced to prevent state races.
class ResyncCoordinator {
  final ProjectionStore _projectionStore;
  final ILocalPersistenceService _persistenceService;
  final Future<LocalTripProjection?> Function(String tripId) _fetchAuthoritativeTrip;

  final Map<String, Completer<LocalTripProjection?>> _inFlightResyncs = {};
  int _resyncCount = 0;

  ResyncCoordinator({
    required ProjectionStore projectionStore,
    required ILocalPersistenceService persistenceService,
    required Future<LocalTripProjection?> Function(String tripId) fetchAuthoritativeTrip,
  })  : _projectionStore = projectionStore,
        _persistenceService = persistenceService,
        _fetchAuthoritativeTrip = fetchAuthoritativeTrip;

  int get resyncCount => _resyncCount;
  bool get isResyncing => _inFlightResyncs.isNotEmpty;
  bool isResyncingTrip(String tripId) => _inFlightResyncs.containsKey(tripId);

  /// Executes Authoritative Resync for a given trip (per-entity single-flight)
  Future<LocalTripProjection?> resyncTrip(String tripId) async {
    // Per-trip single-flight coalescing: If already in-flight for this trip, await existing call
    if (_inFlightResyncs.containsKey(tripId)) {
      return _inFlightResyncs[tripId]!.future;
    }

    final completer = Completer<LocalTripProjection?>();
    completer.future.ignore();
    _inFlightResyncs[tripId] = completer;
    _resyncCount++;

    try {
      final authoritativeSnapshot = await _fetchAuthoritativeTrip(tripId);
      if (authoritativeSnapshot != null) {
        // Apply strictly to projection store (enforces monotonic versioning)
        _projectionStore.applyUpdate(authoritativeSnapshot);
        // Persist to local disk snapshot
        await _persistenceService.saveTripSnapshot(authoritativeSnapshot);
      }
      completer.complete(authoritativeSnapshot);
      return authoritativeSnapshot;
    } catch (e) {
      completer.completeError(e);
      rethrow;
    } finally {
      _inFlightResyncs.remove(tripId);
    }
  }

  /// Concurrently resyncs multiple active trips without cross-entity blocking
  Future<List<LocalTripProjection?>> resyncActiveTrips(List<String> tripIds) {
    return Future.wait(tripIds.map(resyncTrip));
  }
}
