/// Presentation Controller for Phase E4: Operations & Live Fleet Monitoring.
/// Manages reactive state for operational alerts, fleet liveness, and active trips.
library operations_controller;

import 'package:flutter/foundation.dart';
import '../../domain/operations/operations_models.dart';
import '../../domain/operations/operations_service.dart';
import 'view_state.dart';

enum OperationsFilter {
  all,
  exceptionsOnly,
  activeTripsOnly,
  availableDriversOnly,
}

class OperationsController extends ChangeNotifier {
  final OperationsService _operationsService;

  ViewState<List<OperationalAlert>> _alertsState = ViewState.initial();
  ViewState<FleetSummary> _fleetSummaryState = ViewState.initial();
  ViewState<List<FleetDriverLive>> _driversState = ViewState.initial();
  ViewState<List<ActiveTripSummary>> _activeTripsState = ViewState.initial();

  OperationsFilter _activeFilter = OperationsFilter.all;
  bool _isRefreshing = false;

  OperationsController({
    required OperationsService operationsService,
  }) : _operationsService = operationsService;

  ViewState<List<OperationalAlert>> get alertsState => _alertsState;
  ViewState<FleetSummary> get fleetSummaryState => _fleetSummaryState;
  ViewState<List<FleetDriverLive>> get driversState => _driversState;
  ViewState<List<ActiveTripSummary>> get activeTripsState => _activeTripsState;

  OperationsFilter get activeFilter => _activeFilter;
  bool get isRefreshing => _isRefreshing;

  /// Returns sorted alerts with CRITICAL and HIGH severity prioritized first.
  List<OperationalAlert> get prioritizedAlerts {
    final list = _alertsState.data ?? [];
    final sorted = List<OperationalAlert>.from(list);
    sorted.sort((a, b) {
      final aPriority = _severityPriority(a.severity);
      final bPriority = _severityPriority(b.severity);
      return bPriority.compareTo(aPriority);
    });
    return sorted;
  }

  int _severityPriority(AlertSeverity s) {
    switch (s) {
      case AlertSeverity.critical:
        return 5;
      case AlertSeverity.high:
        return 4;
      case AlertSeverity.warning:
        return 3;
      case AlertSeverity.medium:
        return 2;
      case AlertSeverity.info:
        return 1;
    }
  }

  /// Sets the active fleet/incident view filter.
  void setFilter(OperationsFilter filter) {
    _activeFilter = filter;
    notifyListeners();
  }

  /// Loads full operations telemetry from authoritative backend endpoints.
  Future<void> loadDashboardData() async {
    _isRefreshing = true;
    _alertsState = ViewState.loading(_alertsState.data);
    _fleetSummaryState = ViewState.loading(_fleetSummaryState.data);
    _driversState = ViewState.loading(_driversState.data);
    _activeTripsState = ViewState.loading(_activeTripsState.data);
    notifyListeners();

    await _fetchDataInternal();
  }

  /// Refreshes dashboard data while retaining current view states for graceful degradation.
  Future<void> refresh() async {
    _isRefreshing = true;
    notifyListeners();
    await _fetchDataInternal();
  }

  Future<void> _fetchDataInternal() async {
    try {
      // 1. Fetch Alerts (Exception-First)
      final alerts = await _operationsService.fetchOperationalAlerts();
      _alertsState = ViewState.success(alerts);
    } catch (e) {
      _alertsState = ViewState.failure(e.toString(), _alertsState.data);
    }

    try {
      // 2. Fetch Fleet Telemetry
      final fleet = await _operationsService.fetchFleetOverview();
      _fleetSummaryState = ViewState.success(fleet.summary);
      _driversState = ViewState.success(fleet.drivers);
    } catch (e) {
      _fleetSummaryState = ViewState.failure(e.toString(), _fleetSummaryState.data);
      _driversState = ViewState.failure(e.toString(), _driversState.data);
    }

    try {
      // 3. Fetch Active Trips
      final trips = await _operationsService.fetchActiveTrips();
      _activeTripsState = ViewState.success(trips);
    } catch (e) {
      _activeTripsState = ViewState.failure(e.toString(), _activeTripsState.data);
    }

    _isRefreshing = false;
    notifyListeners();
  }

  /// Manual operator intervention: Assign Driver.
  Future<bool> manualAssignDriver(String orderId, String driverId) async {
    try {
      await _operationsService.manualAssignDriver(orderId: orderId, driverId: driverId);
      await refresh();
      return true;
    } catch (e) {
      return false;
    }
  }

  /// Manual operator intervention: Re-Dispatch Order.
  Future<bool> reDispatchTrip(String orderId, {String? reason}) async {
    try {
      await _operationsService.reDispatchTrip(orderId: orderId, reason: reason);
      await refresh();
      return true;
    } catch (e) {
      return false;
    }
  }

  /// Manual operator intervention: Cancel Trip Override.
  Future<bool> cancelTripOverride(String orderId, {String? reason}) async {
    try {
      await _operationsService.cancelTripOverride(orderId: orderId, reason: reason);
      await refresh();
      return true;
    } catch (e) {
      return false;
    }
  }
}
