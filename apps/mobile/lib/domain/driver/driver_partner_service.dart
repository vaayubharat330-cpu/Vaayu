/// Driver Partner Service: authoritative driver lifecycle transitions.
/// Interacts with backend /api/orders/* and /api/driver/* endpoints.
/// Manages optimistic projections while respecting authoritative rollbacks.
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

  DriverPartnerService({
    required ApiClient apiClient,
    required LocalTripProjectionStore projectionStore,
    required LocalPersistenceService persistenceService,
    IdempotencyManager? idempotencyManager,
  })  : _apiClient = apiClient,
        _projectionStore = projectionStore,
        _persistenceService = persistenceService,
        _idempotencyManager = idempotencyManager ?? IdempotencyManager();

  /// Fetches authoritative driver profile and earnings statistics.
  Future<DriverProfile> getProfile({String? driverId}) async {
    final path = driverId != null ? '/api/driver/profile?id=$driverId' : '/api/driver/profile';
    final response = await _apiClient.get(path);
    if (response.statusCode == 200 && response.data is Map<String, dynamic>) {
      return DriverProfile.fromJson(response.data as Map<String, dynamic>);
    }
    throw Exception('Failed to fetch driver profile (${response.statusCode})');
  }

  /// Fetches pending offers assigned to the driver by backend dispatch engine.
  Future<List<DriverOffer>> getOffers({String? driverId}) async {
    final path = driverId != null ? '/api/driver/offers?id=$driverId' : '/api/driver/offers';
    final response = await _apiClient.get(path);
    if (response.statusCode == 200 && response.data is Map<String, dynamic>) {
      final body = response.data as Map<String, dynamic>;
      final rawOffers = body['offers'] as List<dynamic>? ?? [];
      return rawOffers.map((o) => DriverOffer.fromJson(o as Map<String, dynamic>)).toList();
    }
    return [];
  }

  /// Updates authoritative driver duty status (ONLINE / OFFLINE)
  Future<bool> updateDutyStatus({required String status, String? driverId}) async {
    final body = {
      'status': status,
      if (driverId != null) 'driver_id': driverId,
    };
    final response = await _apiClient.post('/api/driver/update', body: body);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (response.data is Map<String, dynamic>) {
        final data = response.data as Map<String, dynamic>;
        return data['success'] == true;
      }
      return true;
    }
    return false;
  }

  /// Submits an authoritative state transition for a trip.
  /// Uses durable idempotency and preserves mutation intent for offline recovery.
  Future<Map<String, dynamic>> submitTransition({
    required String orderId,
    required String action, // accept, start-arriving, arrived-pickup, confirm-pickup, start-transit, arrived-dropoff, complete, cancel
    String? otp,
    Map<String, dynamic>? proof,
    Map<String, dynamic>? metadata,
    String? idempotencyKey,
  }) async {
    final effKey = idempotencyKey ?? _idempotencyManager.getOrCreateKey(intentId: 'driver_${action}_$orderId');

    final payload = <String, dynamic>{
      'orderId': orderId,
      'idempotencyKey': effKey,
      if (otp != null) 'otp': otp,
      if (proof != null) 'proof': proof,
      if (metadata != null) 'metadata': metadata,
    };

    // 1. Persist pending mutation in local persistence queue
    final pendingMutation = PendingMutation(
      intentId: effKey,
      idempotencyKey: effKey,
      tripId: orderId,
      operation: action,
      payload: payload,
      createdAt: DateTime.now(),
    );
    await _persistenceService.savePendingMutation(pendingMutation);

    try {
      // 2. Perform authoritative network transition
      final response = await _apiClient.post(
        '/api/orders/$action',
        body: payload,
        idempotencyKey: effKey,
      );

      if (response.statusCode >= 200 && response.statusCode < 300) {
        final data = response.data is Map<String, dynamic>
            ? response.data as Map<String, dynamic>
            : <String, dynamic>{};
        
        // 3. Remove mutation upon confirmed server acknowledgement
        await _persistenceService.removePendingMutation(effKey);

        // 4. Update projection with authoritative server result
        if (data['order'] != null && data['order'] is Map<String, dynamic>) {
          final orderMap = data['order'] as Map<String, dynamic>;
          final snapshot = LocalTripProjection(
            tripId: orderId,
            status: orderMap['status']?.toString() ?? '',
            version: (orderMap['version'] as num?)?.toInt() ?? 1,
            pickupLat: (orderMap['pickupLat'] as num?)?.toDouble() ?? 0.0,
            pickupLng: (orderMap['pickupLng'] as num?)?.toDouble() ?? 0.0,
            dropLat: (orderMap['dropLat'] as num?)?.toDouble() ?? 0.0,
            dropLng: (orderMap['dropLng'] as num?)?.toDouble() ?? 0.0,
            totalFare: (orderMap['totalFare'] as num?)?.toDouble() ?? 0.0,
            updatedAt: DateTime.now(),
          );
          _projectionStore.applyAuthoritativeSnapshot(snapshot);
        }

        return data;
      } else {
        throw Exception('Transition $action failed with status ${response.statusCode}');
      }
    } catch (e) {
      // Retain mutation in offline queue if transient failure
      rethrow;
    }
  }

  /// Convenience action: Driver accepts assigned dispatch offer
  Future<Map<String, dynamic>> acceptOffer(String orderId, {String? idempotencyKey}) =>
      submitTransition(orderId: orderId, action: 'accept', idempotencyKey: idempotencyKey);

  /// Convenience action: Driver starts navigating towards pickup location
  Future<Map<String, dynamic>> startArriving(String orderId, {String? idempotencyKey}) =>
      submitTransition(orderId: orderId, action: 'start-arriving', idempotencyKey: idempotencyKey);

  /// Convenience action: Driver arrives at customer pickup location (Geofence verified server-side)
  Future<Map<String, dynamic>> arrivedPickup(String orderId, {Map<String, dynamic>? metadata, String? idempotencyKey}) =>
      submitTransition(orderId: orderId, action: 'arrived-pickup', metadata: metadata, idempotencyKey: idempotencyKey);

  /// Convenience action: Driver confirms pickup via customer OTP verification
  Future<Map<String, dynamic>> confirmPickup(String orderId, String otp, {String? idempotencyKey}) =>
      submitTransition(orderId: orderId, action: 'confirm-pickup', otp: otp, idempotencyKey: idempotencyKey);

  /// Convenience action: Driver begins transit towards destination dropoff
  Future<Map<String, dynamic>> startTransit(String orderId, {String? idempotencyKey}) =>
      submitTransition(orderId: orderId, action: 'start-transit', idempotencyKey: idempotencyKey);

  /// Convenience action: Driver arrives at destination dropoff location
  Future<Map<String, dynamic>> arrivedDropoff(String orderId, {Map<String, dynamic>? metadata, String? idempotencyKey}) =>
      submitTransition(orderId: orderId, action: 'arrived-dropoff', metadata: metadata, idempotencyKey: idempotencyKey);

  /// Convenience action: Driver completes trip with Delivery PIN / OTP & Proof
  Future<Map<String, dynamic>> completeTrip(String orderId, String otp, {Map<String, dynamic>? proof, String? idempotencyKey}) =>
      submitTransition(orderId: orderId, action: 'complete', otp: otp, proof: proof, idempotencyKey: idempotencyKey);
}
