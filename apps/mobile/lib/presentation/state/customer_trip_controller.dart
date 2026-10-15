/// Customer Trip Controller: manages UI state for customer booking and active tracking.
/// Binds strictly to CustomerTripService and LocalTripProjectionStore.
/// Does NOT contain any pricing or state transition logic.
library customer_trip_controller;

import 'dart:async';
import '../../core/projection/local_trip_projection.dart';
import '../../core/projection/projection_store.dart';
import '../../domain/customer/customer_models.dart';
import '../../domain/customer/customer_trip_service.dart';
import 'view_state.dart';

class CustomerTripController {
  final CustomerTripService _tripService;
  final LocalTripProjectionStore _projectionStore;

  ViewState<FareEstimateResult> _estimateState = ViewState.initial();
  ViewState<LocalTripProjection> _activeTripState = ViewState.initial();

  final _estimateStreamController = StreamController<ViewState<FareEstimateResult>>.broadcast();
  final _activeTripStreamController = StreamController<ViewState<LocalTripProjection>>.broadcast();

  StreamSubscription? _projectionSubscription;
  String? _currentTrackedTripId;

  CustomerTripController({
    required CustomerTripService tripService,
    required LocalTripProjectionStore projectionStore,
  })  : _tripService = tripService,
        _projectionStore = projectionStore {
    // Listen to projection changes to update active trip view reactively
    _projectionSubscription = _projectionStore.projectionsStream.listen(_onProjectionUpdated);
  }

  ViewState<FareEstimateResult> get estimateState => _estimateState;
  ViewState<LocalTripProjection> get activeTripState => _activeTripState;

  Stream<ViewState<FareEstimateResult>> get estimateStream => _estimateStreamController.stream;
  Stream<ViewState<LocalTripProjection>> get activeTripStream => _activeTripStreamController.stream;

  void _onProjectionUpdated(LocalTripProjection projection) {
    if (_currentTrackedTripId == null || projection.tripId == _currentTrackedTripId) {
      _currentTrackedTripId = projection.tripId;
      _activeTripState = ViewState.success(projection);
      _activeTripStreamController.add(_activeTripState);
    }
  }

  /// Solicits authoritative fare estimate from backend.
  Future<void> requestEstimate(TripEstimateRequest request) async {
    _estimateState = ViewState.loading(_estimateState.data);
    _estimateStreamController.add(_estimateState);

    try {
      final result = await _tripService.getFareEstimate(request);
      if (result.success) {
        _estimateState = ViewState.success(result);
      } else {
        _estimateState = ViewState.failure(result.error ?? 'Unable to estimate fare', _estimateState.data);
      }
    } catch (e) {
      _estimateState = ViewState.failure(e.toString(), _estimateState.data);
    }
    _estimateStreamController.add(_estimateState);
  }

  /// Dispatches booking creation intent with durable idempotency.
  Future<bool> bookTrip(CreateBookingRequest request) async {
    _activeTripState = ViewState.loading(_activeTripState.data);
    _activeTripStreamController.add(_activeTripState);

    try {
      final response = await _tripService.createBooking(request);
      final tripData = response['trip'] as Map<String, dynamic>? ?? response;
      final tripId = tripData['orderId']?.toString() ?? tripData['id']?.toString() ?? '';

      if (tripId.isNotEmpty) {
        _currentTrackedTripId = tripId;
        final proj = _projectionStore.getProjection(tripId);
        if (proj != null) {
          _activeTripState = ViewState.success(proj);
          _activeTripStreamController.add(_activeTripState);
        }
      }
      return true;
    } catch (e) {
      _activeTripState = ViewState.failure(e.toString(), _activeTripState.data);
      _activeTripStreamController.add(_activeTripState);
      return false;
    }
  }

  /// Cancels currently tracked active trip.
  Future<bool> cancelActiveTrip(String reason) async {
    if (_currentTrackedTripId == null) return false;

    _activeTripState = ViewState.loading(_activeTripState.data);
    _activeTripStreamController.add(_activeTripState);

    try {
      await _tripService.cancelTrip(tripId: _currentTrackedTripId!, reason: reason);
      return true;
    } catch (e) {
      _activeTripState = ViewState.failure(e.toString(), _activeTripState.data);
      _activeTripStreamController.add(_activeTripState);
      return false;
    }
  }

  /// Clears active tracking state upon completion or dismissal.
  void clearActiveTrip() {
    _currentTrackedTripId = null;
    _activeTripState = ViewState.initial();
    _activeTripStreamController.add(_activeTripState);
  }

  void dispose() {
    _projectionSubscription?.cancel();
    _estimateStreamController.close();
    _activeTripStreamController.close();
  }
}
