/// Operations Service interacting with authoritative backend control tower APIs.
library operations_service;

import '../../core/network/api_client.dart';
import '../../core/network/idempotency_manager.dart';
import 'operations_models.dart';

class OperationsService {
  final ApiClient _apiClient;
  final IIdempotencyManager _idempotencyManager;
  ApiClient get apiClient => _apiClient;

  OperationsService({required ApiClient apiClient, required IIdempotencyManager idempotencyManager}) : _apiClient = apiClient, _idempotencyManager = idempotencyManager;

  Future<({FleetSummary summary, List<FleetDriverLive> drivers})> fetchFleetOverview({String? status, String? vehicleId}) async {
    final queryParams = <String, dynamic>{};
    if (status != null && status.isNotEmpty) queryParams['status'] = status;
    if (vehicleId != null && vehicleId.isNotEmpty) queryParams['vehicleId'] = vehicleId;
    final response = await _apiClient.get('/api/admin/fleet/live', queryParameters: queryParams.isNotEmpty ? queryParams : null);
    final data = response.data as Map<String, dynamic>;
    return (summary: FleetSummary.fromJson(data['summary'] as Map<String, dynamic>? ?? {}), drivers: (data['drivers'] as List<dynamic>? ?? []).map((d) => FleetDriverLive.fromJson(d as Map<String, dynamic>)).toList());
  }

  Future<List<ActiveTripSummary>> fetchActiveTrips() async {
    final response = await _apiClient.get('/api/admin/trips/active');
    final data = response.data as Map<String, dynamic>;
    return (data['activeTrips'] as List<dynamic>? ?? []).map((t) => ActiveTripSummary.fromJson(t as Map<String, dynamic>)).toList();
  }

  Future<List<OperationalAlert>> fetchOperationalAlerts() async {
    final response = await _apiClient.get('/api/admin/alerts');
    final data = response.data as Map<String, dynamic>;
    return (data['alerts'] as List<dynamic>? ?? []).map((a) => OperationalAlert.fromJson(a as Map<String, dynamic>)).toList();
  }

  Future<Map<String, dynamic>> manualAssignDriver({required String orderId, required String driverId}) async {
    final idempKey = _idempotencyManager.getOrCreateKey(intentId: 'assign:$orderId:$driverId');
    final response = await _apiClient.post('/api/admin/dispatch/assign', body: {'orderId': orderId, 'driverId': driverId, 'idempotencyKey': idempKey}, idempotencyKey: idempKey);
    return response.data as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> reDispatchTrip({required String orderId, String? reason}) async {
    final idempKey = _idempotencyManager.getOrCreateKey(intentId: 'redispatch:$orderId');
    final response = await _apiClient.post('/api/admin/dispatch/redispatch', body: {'orderId': orderId, 'reason': reason ?? 'Operator manual redispatch', 'idempotencyKey': idempKey}, idempotencyKey: idempKey);
    return response.data as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> cancelTripOverride({required String orderId, String? reason}) async {
    final idempKey = _idempotencyManager.getOrCreateKey(intentId: 'cancel_override:$orderId');
    final response = await _apiClient.post('/api/admin/trips/cancel-override', body: {'orderId': orderId, 'reason': reason ?? 'Operator safety cancellation override', 'idempotencyKey': idempKey}, idempotencyKey: idempKey);
    return response.data as Map<String, dynamic>;
  }
}
