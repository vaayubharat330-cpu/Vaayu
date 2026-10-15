import 'dart:async';
import '../persistence/local_persistence_service.dart';
import '../persistence/pending_mutation.dart';
import '../projection/projection_store.dart';

class MutationReplayResult {
  final PendingMutation mutation;
  final bool success;
  final int? statusCode;
  final String? errorCode;
  final String? errorMessage;
  final bool permanentRejection;
  final bool transientFailure;

  const MutationReplayResult({
    required this.mutation,
    required this.success,
    this.statusCode,
    this.errorCode,
    this.errorMessage,
    this.permanentRejection = false,
    this.transientFailure = false,
  });

  /// Factory classifying an HTTP response or execution error
  factory MutationReplayResult.fromResponse({
    required PendingMutation mutation,
    required int statusCode,
    String? errorCode,
    String? errorMessage,
  }) {
    final isSuccess = statusCode >= 200 && statusCode < 300;
    if (isSuccess) {
      return MutationReplayResult(
        mutation: mutation,
        success: true,
        statusCode: statusCode,
      );
    }
    final isPermanent = isPermanentStatusCode(statusCode);
    return MutationReplayResult(
      mutation: mutation,
      success: false,
      statusCode: statusCode,
      errorCode: errorCode ?? (isPermanent ? 'PERMANENT_4XX_REJECTION' : 'TRANSIENT_FAILURE'),
      errorMessage: errorMessage ?? 'Request failed with status $statusCode',
      permanentRejection: isPermanent,
      transientFailure: !isPermanent,
    );
  }

  /// Classifies status codes into permanent rejections vs transient retriable errors
  static bool isPermanentStatusCode(int? statusCode) {
    if (statusCode == null || statusCode <= 0) return false; // Network disconnection / timeouts are transient
    if (statusCode == 408 || statusCode == 429) return false; // Timeout and rate limit are transient
    // 400 Bad Request / Invalid OTP / Validation Error
    // 403 Forbidden / BOLA denied
    // 404 Not Found
    // 409 Conflict / Terminal State
    // 422 Unprocessable Entity
    if (statusCode >= 400 && statusCode < 500) {
      return true;
    }
    // 5xx (500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout) are transient
    return false;
  }
}

/// Offline Mutation Queue Flusher & Conflict Resolver
/// Invariants Enforced:
/// 1. Sequential FIFO replay order.
/// 2. Identical UUIDv4 idempotencyKey preserved across retries and restarts.
/// 3. Blocked dependency check: If a mutation in a chain fails permanently,
///    dependent downstream mutations for the same trip are aborted/rolled back.
/// 4. Authoritative Conflict Reconciliation: If server reports the trip is already
///    CANCELLED or terminal, stale queued mutations are aborted rather than blindly executed.
class OfflineQueueFlusher {
  final ILocalPersistenceService _persistenceService;
  final ProjectionStore _projectionStore;
  final Future<MutationReplayResult> Function(PendingMutation mutation) _executeMutation;

  bool _isFlushing = false;

  OfflineQueueFlusher({
    required ILocalPersistenceService persistenceService,
    required ProjectionStore projectionStore,
    required Future<MutationReplayResult> Function(PendingMutation mutation) executeMutation,
  })  : _persistenceService = persistenceService,
        _projectionStore = projectionStore,
        _executeMutation = executeMutation;

  bool get isFlushing => _isFlushing;

  /// Flushes all pending mutations sequentially in strict FIFO order
  Future<List<MutationReplayResult>> flushQueue() async {
    if (_isFlushing) return [];
    _isFlushing = true;

    final results = <MutationReplayResult>[];

    try {
      final queue = await _persistenceService.getPendingMutations();
      final blockedTripIds = <String>{};

      for (final mutation in queue) {
        // Invariant: If a previous mutation for this trip failed permanently,
        // do not blindly execute dependent downstream actions!
        if (blockedTripIds.contains(mutation.tripId)) {
          results.add(MutationReplayResult(
            mutation: mutation,
            success: false,
            permanentRejection: true,
            errorCode: 'BLOCKED_BY_PRIOR_FAILURE',
            errorMessage: 'Dependency failure in queued action chain for trip ${mutation.tripId}',
          ));
          await _persistenceService.removeMutation(mutation.intentId);
          continue;
        }

        // Invariant: Conflict Check against current Authoritative Projection
        final currentTrip = _projectionStore.getProjection(mutation.tripId);
        if (currentTrip != null) {
          if (currentTrip.status == 'CANCELLED' || currentTrip.status == 'DELIVERED') {
            // Server has already moved to terminal state! Queued action is stale.
            blockedTripIds.add(mutation.tripId);
            results.add(MutationReplayResult(
              mutation: mutation,
              success: false,
              permanentRejection: true,
              errorCode: 'CONFLICT_TERMINAL_STATE',
              errorMessage: 'Cannot replay mutation on trip in terminal state ${currentTrip.status}',
            ));
            await _persistenceService.removeMutation(mutation.intentId);
            continue;
          }
        }

        // Execute mutation across transport
        final result = await _executeMutation(mutation);
        results.add(result);

        if (result.success) {
          // Success: Cleanly purge this specific mutation from persistent storage
          await _persistenceService.removeMutation(mutation.intentId);
        } else if (result.permanentRejection) {
          // Permanent rejection (e.g. Geofence violation, BOLA denied, invalid OTP):
          // Block trip queue and purge rejected mutation
          blockedTripIds.add(mutation.tripId);
          await _persistenceService.removeMutation(mutation.intentId);
        } else {
          // Transient failure (network drop): Update retry counter in storage and HALT queue replay
          await _persistenceService.enqueueMutation(mutation.copyWithRetry());
          break; // Stop sequential replay until network stabilizes
        }
      }
    } finally {
      _isFlushing = false;
    }

    return results;
  }
}
