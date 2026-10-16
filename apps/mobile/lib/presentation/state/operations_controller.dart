/// Presentation Controller for Operations & Live Fleet Monitoring.
library operations_controller;

import 'package:flutter/foundation.dart';
import '../../core/network/api_client.dart';
import '../../domain/operations/operations_models.dart';
import '../../domain/operations/operations_service.dart';
import 'view_state.dart';

enum OperationsFilter { all, exceptionsOnly, activeTripsOnly, availableDriversOnly }

class OperationsController extends ChangeNotifier {
  final OperationsService _operationsService;
  ViewState<List<OperationalAlert>> _alertsState = ViewState.initial();
  ViewState<FleetSummary> _fleetSummaryState = ViewState.initial();
  ViewState<List<FleetDriverLive>> _driversState = ViewState.initial();
  ViewState<List<ActiveTripSummary>> _activeTripsState = ViewState.initial();
  OperationsFilter _activeFilter = OperationsFilter.all;
  bool _isRefreshing = false;

  OperationsController({required OperationsService operationsService}) : _operationsService = operationsService;
  ApiClient get apiClient => _operationsService.apiClient;
  ViewState<List<OperationalAlert>> get alertsState => _alertsState;
  ViewState<FleetSummary> get fleetSummaryState => _fleetSummaryState;
  ViewState<List<FleetDriverLive>> get driversState => _driversState;
  ViewState<List<ActiveTripSummary>> get activeTripsState => _activeTripsState;
  OperationsFilter get activeFilter => _activeFilter;
  bool get isRefreshing => _isRefreshing;

  List<OperationalAlert> get prioritizedAlerts {
    final list = List<OperationalAlert>.from(_alertsState.data ?? []);
    list.sort((a, b) => _severityPriority(b.severity).compareTo(_severityPriority(a.severity)));
    return list;
  }
  int _severityPriority(AlertSeverity s) => switch (s) { AlertSeverity.critical => 5, AlertSeverity.high => 4, AlertSeverity.warning => 3, AlertSeverity.medium => 2, AlertSeverity.info => 1 };
  void setFilter(OperationsFilter filter) { _activeFilter = filter; notifyListeners(); }

  Future<void> loadDashboardData() async { _isRefreshing = true; _alertsState = ViewState.loading(_alertsState.data); _fleetSummaryState = ViewState.loading(_fleetSummaryState.data); _driversState = ViewState.loading(_driversState.data); _activeTripsState = ViewState.loading(_activeTripsState.data); notifyListeners(); await _fetchDataInternal(); }
  Future<void> refresh() async { _isRefreshing = true; notifyListeners(); await _fetchDataInternal(); }
  Future<void> _fetchDataInternal() async {
    try { _alertsState = ViewState.success(await _operationsService.fetchOperationalAlerts()); } catch (e) { _alertsState = ViewState.failure(e.toString(), _alertsState.data); }
    try { final fleet = await _operationsService.fetchFleetOverview(); _fleetSummaryState = ViewState.success(fleet.summary); _driversState = ViewState.success(fleet.drivers); } catch (e) { _fleetSummaryState = ViewState.failure(e.toString(), _fleetSummaryState.data); _driversState = ViewState.failure(e.toString(), _driversState.data); }
    try { _activeTripsState = ViewState.success(await _operationsService.fetchActiveTrips()); } catch (e) { _activeTripsState = ViewState.failure(e.toString(), _activeTripsState.data); }
    _isRefreshing = false; notifyListeners();
  }
  Future<bool> manualAssignDriver(String orderId, String driverId) async { try { await _operationsService.manualAssignDriver(orderId: orderId, driverId: driverId); await refresh(); return true; } catch (_) { return false; } }
  Future<bool> reDispatchTrip(String orderId, {String? reason}) async { try { await _operationsService.reDispatchTrip(orderId: orderId, reason: reason); await refresh(); return true; } catch (_) { return false; } }
  Future<bool> cancelTripOverride(String orderId, {String? reason}) async { try { await _operationsService.cancelTripOverride(orderId: orderId, reason: reason); await refresh(); return true; } catch (_) { return false; } }
}
