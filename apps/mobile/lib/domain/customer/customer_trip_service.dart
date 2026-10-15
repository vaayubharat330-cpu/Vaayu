/// Customer Trip Service: authoritative customer operations.
/// Interacts directly with backend APIs via ApiClient.
/// Stores and projects active trips through LocalTripProjectionStore.
library customer_trip_service;

import '../../core/network/api_client.dart';
import '../../core/network/idempotency_manager.dart';
import '../../core/projection/local_trip_projection.dart';
import '../../core/projection/projection_store.dart';
import '../../core/persistence/local_persistence_service.dart';
import '../../core/persistence/pending_mutation.dart';
import 'customer_models.dart';

class CustomerTripService {
  final ApiClient _apiClient;
  final LocalTripProjectionStore _projectionStore;
  final LocalPersistenceService _persistenceService;
  final IdempotencyManager _idempotencyManager;

  CustomerTripService({
    required ApiClient apiClient,
    required LocalTripProjectionStore projectionStore,
    required LocalPersistenceService persistenceService,
    IdempotencyManager? idempotencyManager,
  })  : _apiClient = apiClient,
        _projectionStore = projectionStore,
        _persistenceService = persistenceService,
        _idempotencyManager = idempotencyManager ?? IdempotencyManager();

  /// Fetches authoritative fare estimation from the server.
  /// Customer pricing is NEVER calculated locally.
  Future<FareEstimateResult> getFareEstimate(TripEstimateRequest request) async {
    final response = await _apiClient.post(
      '/api/trips/estimate',
      body: request.toJson(),
    );

    if (response.statusCode >= 200 && response.statusCode < 300) {
      final data = response.data is Map<String, dynamic>
          ? response.data as Map<String, dynamic>
          : <String, dynamic>{};
      return FareEstimateResult.fromJson(data);
    } else {
      final errorMsg = response.data is Map && (response.data as Map)['error'] != null
          ? (response.data as Map)['error'].toString()
          : 'Failed to retrieve fare estimate (${response.statusCode})';
      return FareEstimateResult(
        success: false,
        error: errorMsg,
      );
    }
  }

  /// Creates a trip booking with durable idempotency.
  /// Saves pending mutation intent prior to network flight.
  /// Updates local projection immediately upon authoritative response.
  Future<Map<String, dynamic>> createBooking(CreateBookingRequest request) async {
    final effKey = request.idempotencyKey.isNotEmpty
        ? request.idempotencyKey
        : _idempotencyManager.getOrCreateKey(intentId: 'create_trip_${_idempotencyManager.generateUuidV4()}');

    final effectiveRequest = request.idempotencyKey == effKey
        ? request
        : request.copyWith(idempotencyKey: effKey);
    final payload = effectiveRequest.toJson();

    // Record pending mutation intent for offline/recovery persistence
    final pendingMutation = PendingMutation(
      intentId: effKey,
      idempotencyKey: effKey,
      tripId: 'PENDING_ORDER',
      operation: 'create_trip',
      payload: payload,
      createdAt: DateTime.now(),
    );
    await _persistenceService.savePendingMutation(pendingMutation);

    try {
      final response = await _apiClient.post(
        '/api/trips/create',
        body: payload,
        idempotencyKey: effKey,
      );

      if (response.statusCode >= 200 && response.statusCode < 300) {
        final data = response.data is Map<String, dynamic>
            ? response.data as Map<String, dynamic>
            : <String, dynamic>{};
        final tripData = data['trip'] as Map<String, dynamic>? ?? data;
        final tripId = tripData['orderId']?.toString() ?? tripData['id']?.toString() ?? '';

        // Purge pending creation intent on success
        await _persistenceService.removePendingMutation(effKey);

        if (tripId.isNotEmpty) {
          final snapshot = LocalTripProjection(
            tripId: tripId,
            status: tripData['status']?.toString() ?? 'CREATED',
            version: (tripData['version'] as num?)?.toInt() ?? 1,
            pickupLat: (tripData['pickupLat'] as num?)?.toDouble() ?? request.pickupLat,
            pickupLng: (tripData['pickupLng'] as num?)?.toDouble() ?? request.pickupLng,
            dropLat: (tripData['dropLat'] as num?)?.toDouble() ?? request.dropLat,
            dropLng: (tripData['dropLng'] as num?)?.toDouble() ?? request.dropLng,
            totalFare: (tripData['totalFare'] as num?)?.toDouble() ?? 0.0,
            updatedAt: DateTime.now(),
          );
          _projectionStore.applyAuthoritativeSnapshot(snapshot);
        }

        return data;
      } else {
        final errorMsg = response.data is Map && (response.data as Map)['error'] != null
            ? (response.data as Map)['error'].toString()
            : 'Booking failed with status ${response.statusCode}';
        throw Exception(errorMsg);
      }
    } catch (e) {
      // Intent remains in persistence if transient failure occurred
      rethrow;
    }
  }

  /// Cancels an active trip with durable idempotency.
  Future<Map<String, dynamic>> cancelTrip({
    required String tripId,
    required String reason,
    String? idempotencyKey,
  }) async {
    final effKey = idempotencyKey ?? _idempotencyManager.getOrCreateKey(intentId: 'cancel_$tripId');

    final response = await _apiClient.post(
      '/api/orders/cancel',
      body: {
        'orderId': tripId,
        'reason': reason,
        'idempotencyKey': effKey,
      },
      idempotencyKey: effKey,
    );

    if (response.statusCode >= 200 && response.statusCode < 300) {
      final data = response.data is Map<String, dynamic>
          ? response.data as Map<String, dynamic>
          : <String, dynamic>{};
      if (data['order'] != null && data['order'] is Map<String, dynamic>) {
        final orderMap = data['order'] as Map<String, dynamic>;
        final snapshot = LocalTripProjection(
          tripId: tripId,
          status: orderMap['status']?.toString() ?? 'CANCELLED',
          version: (orderMap['version'] as num?)?.toInt() ?? 999,
          pickupLat: 0.0,
          pickupLng: 0.0,
          dropLat: 0.0,
          dropLng: 0.0,
          totalFare: 0.0,
          updatedAt: DateTime.now(),
        );
        _projectionStore.applyAuthoritativeSnapshot(snapshot);
      }
      return data;
    } else {
      throw Exception('Failed to cancel trip (${response.statusCode})');
    }
  }

  /// Refreshes authoritative tracking data for the active trip.
  Future<LocalTripProjection?> trackTrip(String tripId) async {
    final response = await _apiClient.get('/api/orders/track/$tripId');
    if (response.statusCode == 200 && response.data is Map<String, dynamic>) {
      final data = response.data as Map<String, dynamic>;
      final snapshot = LocalTripProjection(
        tripId: tripId,
        status: data['status']?.toString() ?? 'UNKNOWN',
        version: (data['version'] as num?)?.toInt() ?? 1,
        pickupLat: (data['pickupLat'] as num?)?.toDouble() ?? 0.0,
        pickupLng: (data['pickupLng'] as num?)?.toDouble() ?? 0.0,
        dropLat: (data['dropLat'] as num?)?.toDouble() ?? 0.0,
        dropLng: (data['dropLng'] as num?)?.toDouble() ?? 0.0,
        totalFare: (data['totalFare'] as num?)?.toDouble() ?? 0.0,
        updatedAt: DateTime.now(),
      );
      _projectionStore.applyAuthoritativeSnapshot(snapshot);
      return snapshot;
    }
    return _projectionStore.getProjection(tripId);
  }
}
