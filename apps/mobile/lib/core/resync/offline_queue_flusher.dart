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

  factory MutationReplayResult.fromResponse({
    required PendingMutation mutation,
    required int statusCode,
    String? errorCode,
    String? errorMessage,
  }) {
    final isSuccess = statusCode >= 200 && statusCode < 300;
    if (isSuccess) {
      return MutationReplayResult(mutation: mutation, success: true, statusCode: statusCode);
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

  static bool isPermanentStatusCode(int? statusCode) {
    if (statusCode == null || statusCode <= 0) return false;
    if (statusCode == 408 || statusCode == 429) return false;
    if (statusCode >= 400 && statusCode < 500) return true;
    return false;
  }
}

/// Offline Mutation Queue Flusher & Conflict Resolver.
///
/// Invariants enforced:
/// 1. Strict FIFO ordering for executable mutations.
/// 2. Identical idempotency key is preserved across every retry.
/// 3. A transient failure pauses the queue rather than racing later mutations.
/// 4. Retry backoff is persisted, preventing reconnect storms/hot loops.
/// 5. Terminal authoritative state blocks stale downstream actions.
/// 6. Permanent validation/security failures are removed so they cannot poison
///    the queue forever.
class OfflineQueueFlusher {
  static const int maxRetryCount = 12;
  static const Duration maxRetryDelay = Duration(minutes: 5);

  final ILocalPersistenceService _persistenceService;
  final ProjectionStore _projectionStore;
  final Future<MutationReplayResult> Function(PendingMutation mutation) _executeMutation;
  final DateTime Function() _now;

  bool _isFlushing = false;

  OfflineQueueFlusher({
    required ILocalPersistenceService persistenceService,
    required ProjectionStore projectionStore,
    required Future<MutationReplayResult> Function(PendingMutation mutation) executeMutation,
    DateTime Function()? now,
  })  : _persistenceService = persistenceService,
        _projectionStore = projectionStore,
        _executeMutation = executeMutation,
        _now = now ?? (() => DateTime.now().toUtc());

  bool get isFlushing => _isFlushing;

  Duration _retryDelay(int retryCount) {
    final exponent = retryCount.clamp(1, 8);
    final seconds = 1 << (exponent - 1);
    final delay = Duration(seconds: seconds);
    return delay > maxRetryDelay ? maxRetryDelay : delay;
  }

  Future<List<MutationReplayResult>> flushQueue() async {
    if (_isFlushing) return [];
    _isFlushing = true;

    final results = <MutationReplayResult>[];
    try {
      final queue = await _persistenceService.getPendingMutations();
      final blockedTripIds = <String>{};
      final now = _now().toUtc();

      for (final mutation in queue) {
        if (!mutation.isReadyForReplay && mutation.nextAttemptAt != null && mutation.nextAttemptAt!.isAfter(now)) {
          // FIFO: later mutations must not leapfrog an earlier retry window.
          break;
        }

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

        final currentTrip = _projectionStore.getProjection(mutation.tripId);
        if (currentTrip != null && (currentTrip.status == 'CANCELLED' || currentTrip.status == 'DELIVERED')) {
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

        final result = await _executeMutation(mutation);
        results.add(result);

        if (result.success) {
          await _persistenceService.removeMutation(mutation.intentId);
          continue;
        }

        if (result.permanentRejection) {
          blockedTripIds.add(mutation.tripId);
          await _persistenceService.removeMutation(mutation.intentId);
          continue;
        }

        // Preserve the same intent/idempotency key while replacing the queue
        // record with a scheduled retry. The queue is deliberately halted.
        final nextRetryCount = mutation.retryCount + 1;
        if (nextRetryCount >= maxRetryCount) {
          final parked = mutation.copyWithRetry(
            nextAttemptAt: now.add(maxRetryDelay),
            lastErrorCode: result.errorCode ?? 'RETRY_EXHAUSTED',
            lastFailureAt: now,
          );
          await _persistenceService.enqueueMutation(parked);
        } else {
          final scheduled = mutation.copyWithRetry(
            nextAttemptAt: now.add(_retryDelay(nextRetryCount)),
            lastErrorCode: result.errorCode ?? 'TRANSIENT_FAILURE',
            lastFailureAt: now,
          );
          await _persistenceService.enqueueMutation(scheduled);
        }
        break;
      }
    } finally {
      _isFlushing = false;
    }

    return results;
  }
}
