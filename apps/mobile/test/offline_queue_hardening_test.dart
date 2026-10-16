import 'package:flutter_test/flutter_test.dart';
import '../lib/core/persistence/local_persistence_service.dart';
import '../lib/core/persistence/pending_mutation.dart';
import '../lib/core/projection/projection_store.dart';
import '../lib/core/resync/offline_queue_flusher.dart';

void main() {
  test('transient replay preserves idempotency and schedules retry', () async {
    final persistence = InMemoryLocalPersistenceService();
    final original = PendingMutation(
      intentId: 'intent-1',
      idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
      operation: 'confirm-pickup',
      tripId: 'trip-1',
      payload: const {'otp': '1234'},
      createdAt: DateTime.utc(2026, 10, 16, 10),
    );
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
  });

  test('replay classifies 408 and 429 as transient and other 4xx as permanent', () {
    expect(MutationReplayResult.isPermanentStatusCode(408), isFalse);
    expect(MutationReplayResult.isPermanentStatusCode(429), isFalse);
    expect(MutationReplayResult.isPermanentStatusCode(403), isTrue);
    expect(MutationReplayResult.isPermanentStatusCode(422), isTrue);
    expect(MutationReplayResult.isPermanentStatusCode(503), isFalse);
  });
}
