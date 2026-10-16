/// Driver Partner Service: authoritative driver lifecycle transitions.
/// Interacts with backend /api/orders/* and /api/driver/* endpoints.
library driver_partner_service;

import '../../core/network/api_client.dart';
import '../../core/network/idempotency_manager.dart';
import '../../core/projection/local_trip_projection.dart';
import '../../core/projection/projection_store.dart';
import '../../core/persistence/local_persistence_service.dart';
import '../../core/persistence/pending_mutation.dart';
import 'driver_models.dart';

class DriverPartnerService {
  final ApiClient _apiClient;
  final LocalTripProjectionStore _projectionStore;
  final LocalPersistenceService _persistenceService;
  final IdempotencyManager _idempotencyManager;

  ApiClient get apiClient => _apiClient;

  DriverPartnerService({required ApiClient apiClient, required LocalTripProjectionStore projectionStore, required LocalPersistenceService persistenceService, IdempotencyManager? idempotencyManager})
      : _apiClient = apiClient,
        _projectionStore = projectionStore,
        _persistenceService = persistenceService,
        _idempotencyManager = idempotencyManager ?? IdempotencyManager();

  Future<DriverProfile> getProfile({String? driverId}) async {
    final path = driverId != null ? '/api/driver/profile?id=$driverId' : '/api/driver/profile';
    final response = await _apiClient.get(path);
    if (response.statusCode == 200 && response.data is Map<String, dynamic>) return DriverProfile.fromJson(response.data as Map<String, dynamic>);
    throw Exception('Failed to fetch driver profile (${response.statusCode})');
  }

  Future<List<DriverOffer>> getOffers({String? driverId}) async {
    final path = driverId != null ? '/api/driver/offers?id=$driverId' : '/api/driver/offers';
    final response = await _apiClient.get(path);
    if (response.statusCode == 200 && response.data is Map<String, dynamic>) {
      final rawOffers = (response.data as Map<String, dynamic>)['offers'] as List<dynamic>? ?? [];
      return rawOffers.map((o) => DriverOffer.fromJson(o as Map<String, dynamic>)).toList();
    }
    return [];
  }

  Future<bool> updateDutyStatus({required String status, String? driverId}) async {
    final response = await _apiClient.post('/api/driver/update', body: {'status': status, if (driverId != null) 'driver_id': driverId});
    if (response.statusCode >= 200 && response.statusCode < 300) return response.data is! Map<String, dynamic> || (response.data as Map<String, dynamic>)['success'] == true;
    return false;
  }

  Future<Map<String, dynamic>> submitTransition({required String orderId, required String action, String? otp, Map<String, dynamic>? proof, Map<String, dynamic>? metadata, String? idempotencyKey}) async {
    final effKey = idempotencyKey ?? _idempotencyManager.getOrCreateKey(intentId: 'driver_${action}_$orderId');
    final payload = <String, dynamic>{'orderId': orderId, 'idempotencyKey': effKey, if (otp != null) 'otp': otp, if (proof != null) 'proof': proof, if (metadata != null) 'metadata': metadata};
    final pendingMutation = PendingMutation(intentId: effKey, idempotencyKey: effKey, tripId: orderId, operation: action, payload: payload, createdAt: DateTime.now());
    await _persistenceService.savePendingMutation(pendingMutation);
    try {
      final response = await _apiClient.post('/api/orders/$action', body: payload, idempotencyKey: effKey);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        final data = response.data is Map<String, dynamic> ? response.data as Map<String, dynamic> : <String, dynamic>{};
        await _persistenceService.removePendingMutation(effKey);
        if (data['order'] is Map<String, dynamic>) {
          final orderMap = data['order'] as Map<String, dynamic>;
          _projectionStore.applyAuthoritativeSnapshot(LocalTripProjection(tripId: orderId, status: orderMap['status']?.toString() ?? '', version: (orderMap['version'] as num?)?.toInt() ?? 1, pickupLat: (orderMap['pickupLat'] as num?)?.toDouble() ?? 0.0, pickupLng: (orderMap['pickupLng'] as num?)?.toDouble() ?? 0.0, dropLat: (orderMap['dropLat'] as num?)?.toDouble() ?? 0.0, dropLng: (orderMap['dropLng'] as num?)?.toDouble() ?? 0.0, totalFare: (orderMap['totalFare'] as num?)?.toDouble() ?? 0.0, updatedAt: DateTime.now()));
        }
        return data;
      }
      throw Exception('Transition $action failed with status ${response.statusCode}');
    } catch (_) {
      rethrow;
    }
  }

  Future<Map<String, dynamic>> acceptOffer(String orderId, {String? idempotencyKey}) => submitTransition(orderId: orderId, action: 'accept', idempotencyKey: idempotencyKey);
  Future<Map<String, dynamic>> startArriving(String orderId, {String? idempotencyKey}) => submitTransition(orderId: orderId, action: 'start-arriving', idempotencyKey: idempotencyKey);
  Future<Map<String, dynamic>> arrivedPickup(String orderId, {Map<String, dynamic>? metadata, String? idempotencyKey}) => submitTransition(orderId: orderId, action: 'arrived-pickup', metadata: metadata, idempotencyKey: idempotencyKey);
  Future<Map<String, dynamic>> confirmPickup(String orderId, String otp, {String? idempotencyKey}) => submitTransition(orderId: orderId, action: 'confirm-pickup', otp: otp, idempotencyKey: idempotencyKey);
  Future<Map<String, dynamic>> startTransit(String orderId, {String? idempotencyKey}) => submitTransition(orderId: orderId, action: 'start-transit', idempotencyKey: idempotencyKey);
  Future<Map<String, dynamic>> arrivedDropoff(String orderId, {Map<String, dynamic>? metadata, String? idempotencyKey}) => submitTransition(orderId: orderId, action: 'arrived-dropoff', metadata: metadata, idempotencyKey: idempotencyKey);
  Future<Map<String, dynamic>> completeTrip(String orderId, String otp, {Map<String, dynamic>? proof, String? idempotencyKey}) => submitTransition(orderId: orderId, action: 'complete', otp: otp, proof: proof, idempotencyKey: idempotencyKey);
}
