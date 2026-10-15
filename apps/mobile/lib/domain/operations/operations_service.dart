/// Operations Service interacting with authoritative backend control tower APIs.
library operations_service;

import '../../core/network/api_client.dart';
import '../../core/network/idempotency_manager.dart';
import 'operations_models.dart';

class OperationsService {
  final ApiClient _apiClient;
  final IIdempotencyManager _idempotencyManager;

  OperationsService({
    required ApiClient apiClient,
    required IIdempotencyManager idempotencyManager,
  })  : _apiClient = apiClient,
        _idempotencyManager = idempotencyManager;

  /// Fetches real-time fleet overview with driver telemetry states.
  Future<({FleetSummary summary, List<FleetDriverLive> drivers})> fetchFleetOverview({
    String? status,
    String? vehicleId,
  }) async {
    final queryParams = <String, dynamic>{};
    if (status != null && status.isNotEmpty) queryParams['status'] = status;
    if (vehicleId != null && vehicleId.isNotEmpty) queryParams['vehicleId'] = vehicleId;

    final response = await _apiClient.get(
      '/api/admin/fleet/live',
      queryParameters: queryParams.isNotEmpty ? queryParams : null,
    );
    final data = response.data as Map<String, dynamic>;

    final summaryJson = data['summary'] as Map<String, dynamic>? ?? {};
    final summary = FleetSummary.fromJson(summaryJson);

    final driversJson = data['drivers'] as List<dynamic>? ?? [];
    final drivers = driversJson
        .map((d) => FleetDriverLive.fromJson(d as Map<String, dynamic>))
        .toList();

    return (summary: summary, drivers: drivers);
  }

  /// Fetches all active in-progress trips with live ETA and lock statuses.
  Future<List<ActiveTripSummary>> fetchActiveTrips() async {
    final response = await _apiClient.get('/api/admin/trips/active');
    final data = response.data as Map<String, dynamic>;
    final tripsJson = data['activeTrips'] as List<dynamic>? ?? [];
    return tripsJson
        .map((t) => ActiveTripSummary.fromJson(t as Map<String, dynamic>))
        .toList();
  }

  /// Fetches authoritative operational alerts for exception-first triage.
  Future<List<OperationalAlert>> fetchOperationalAlerts() async {
    final response = await _apiClient.get('/api/admin/alerts');
    final data = response.data as Map<String, dynamic>;
    final alertsJson = data['alerts'] as List<dynamic>? ?? [];
    return alertsJson
        .map((a) => OperationalAlert.fromJson(a as Map<String, dynamic>))
        .toList();
  }

  /// Manual operator driver assignment intervention.
  Future<Map<String, dynamic>> manualAssignDriver({
    required String orderId,
    required String driverId,
  }) async {
    final idempKey = _idempotencyManager.getOrCreateKey(intentId: 'assign:$orderId:$driverId');
    final body = {
      'orderId': orderId,
      'driverId': driverId,
      'idempotencyKey': idempKey,
    };
    final response = await _apiClient.post(
      '/api/admin/dispatch/assign',
      body: body,
      idempotencyKey: idempKey,
    );
    return response.data as Map<String, dynamic>;
  }

  /// Manual operator re-dispatch trigger for stalled or rejected trips.
  Future<Map<String, dynamic>> reDispatchTrip({
    required String orderId,
    String? reason,
  }) async {
    final idempKey = _idempotencyManager.getOrCreateKey(intentId: 'redispatch:$orderId');
    final body = {
      'orderId': orderId,
      'reason': reason ?? 'Operator manual redispatch',
      'idempotencyKey': idempKey,
    };
    final response = await _apiClient.post(
      '/api/admin/dispatch/redispatch',
      body: body,
      idempotencyKey: idempKey,
    );
    return response.data as Map<String, dynamic>;
  }

  /// Manual operator cancellation override with reason.
  Future<Map<String, dynamic>> cancelTripOverride({
    required String orderId,
    String? reason,
  }) async {
    final idempKey = _idempotencyManager.getOrCreateKey(intentId: 'cancel_override:$orderId');
    final body = {
      'orderId': orderId,
      'reason': reason ?? 'Operator safety cancellation override',
      'idempotencyKey': idempKey,
    };
    final response = await _apiClient.post(
      '/api/admin/trips/cancel-override',
      body: body,
      idempotencyKey: idempKey,
    );
    return response.data as Map<String, dynamic>;
  }
}
