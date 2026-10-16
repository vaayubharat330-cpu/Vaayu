import 'package:flutter_test/flutter_test.dart';
import '../lib/core/persistence/local_persistence_service.dart';
import '../lib/core/persistence/pending_mutation.dart';
import '../lib/core/projection/projection_store.dart';
import '../lib/core/resync/offline_queue_flusher.dart';

PendingMutation _mutation({int retryCount = 0, bool retryExhausted = false}) => PendingMutation(
      intentId: 'intent-1',
      idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
      operation: 'confirm-pickup',
      tripId: 'trip-1',
      payload: const {'otp': '1234'},
      createdAt: DateTime.utc(2026, 10, 16, 10),
      retryCount: retryCount,
      retryExhausted: retryExhausted,
    );

void main() {
  test('transient replay preserves idempotency and schedules retry', () async {
    final persistence = InMemoryLocalPersistenceService();
    final original = _mutation();
    await persistence.enqueueMutation(original);
    final now = DateTime.utc(2026, 10, 16, 10, 1);

    final flusher = OfflineQueueFlusher(
      persistenceService: persistence,
      projectionStore: ProjectionStore(),
      now: () => now,
      executeMutation: (mutation) async => MutationReplayResult(
        mutation: mutation,
        success: false,
        transientFailure: true,
        errorCode: 'NETWORK_UNAVAILABLE',
      ),
    );

    await flusher.flushQueue();
    final queued = (await persistence.getPendingMutations()).single;
    expect(queued.intentId, original.intentId);
    expect(queued.idempotencyKey, original.idempotencyKey);
    expect(queued.retryCount, 1);
    expect(queued.nextAttemptAt, now.add(const Duration(seconds: 1)));
    expect(queued.lastErrorCode, 'NETWORK_UNAVAILABLE');
    expect(queued.retryExhausted, isFalse);
  });

  test('retry exhaustion is durably parked and never executes again', () async {
    final persistence = InMemoryLocalPersistenceService();
    await persistence.enqueueMutation(_mutation(retryCount: OfflineQueueFlusher.maxRetryCount - 1));
    final now = DateTime.utc(2026, 10, 16, 10, 1);
    var executions = 0;

    final flusher = OfflineQueueFlusher(
      persistenceService: persistence,
      projectionStore: ProjectionStore(),
      now: () => now,
      executeMutation: (mutation) async {
        executions++;
        return MutationReplayResult(
          mutation: mutation,
          success: false,
          transientFailure: true,
          errorCode: 'SERVER_UNAVAILABLE',
        );
      },
    );

    final first = await flusher.flushQueue();
    final parked = (await persistence.getPendingMutations()).single;
    expect(executions, 1);
    expect(first.single.retryExhausted, isFalse);
    expect(parked.retryCount, OfflineQueueFlusher.maxRetryCount);
    expect(parked.retryExhausted, isTrue);
    expect(parked.lastErrorCode, 'RETRY_EXHAUSTED');

    final second = await flusher.flushQueue();
    expect(executions, 1);
    expect(second.single.retryExhausted, isTrue);
    expect((await persistence.getPendingMutations()).single.retryExhausted, isTrue);
  });

  test('manual retry resets exhaustion but keeps business identity', () {
    final parked = _mutation(retryCount: OfflineQueueFlusher.maxRetryCount, retryExhausted: true);
    final recovered = parked.copyForManualRetry();
    expect(recovered.intentId, parked.intentId);
    expect(recovered.idempotencyKey, parked.idempotencyKey);
    expect(recovered.retryCount, 0);
    expect(recovered.retryExhausted, isFalse);
    expect(recovered.nextAttemptAt, isNull);
    expect(recovered.lastErrorCode, isNull);
  });

  test('retry exhaustion survives persistence serialization', () {
    final original = _mutation(retryCount: OfflineQueueFlusher.maxRetryCount, retryExhausted: true);
    final restored = PendingMutation.fromJson(original.toJson());
    expect(restored.retryCount, original.retryCount);
    expect(restored.retryExhausted, isTrue);
    expect(restored.idempotencyKey, original.idempotencyKey);
  });

  test('replay classifies 408 and 429 as transient and other 4xx as permanent', () {
    expect(MutationReplayResult.isPermanentStatusCode(408), isFalse);
    expect(MutationReplayResult.isPermanentStatusCode(429), isFalse);
    expect(MutationReplayResult.isPermanentStatusCode(403), isTrue);
    expect(MutationReplayResult.isPermanentStatusCode(422), isTrue);
    expect(MutationReplayResult.isPermanentStatusCode(503), isFalse);
  });
}
