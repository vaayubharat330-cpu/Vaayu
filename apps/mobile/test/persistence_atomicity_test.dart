import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import '../lib/core/persistence/local_persistence_service.dart';
import '../lib/core/persistence/pending_mutation.dart';

void main() {
  test('file persistence round-trips retry metadata', () async {
    final directory = await Directory.systemTemp.createTemp('vaayu-persistence-test-');
    addTearDown(() => directory.delete(recursive: true));
    final service = FileLocalPersistenceService(directory: directory);
    final mutation = PendingMutation(
      intentId: 'intent-atomic-1',
      idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
      operation: 'complete',
      tripId: 'trip-atomic-1',
      payload: const {'proof': 'ref'},
      createdAt: DateTime.utc(2026, 10, 16, 10),
      retryCount: 3,
      nextAttemptAt: DateTime.utc(2026, 10, 16, 10, 1),
      lastErrorCode: 'NETWORK_UNAVAILABLE',
      lastFailureAt: DateTime.utc(2026, 10, 16, 10, 0, 30),
    );

    await service.enqueueMutation(mutation);
    final restored = (await service.getPendingMutations()).single;
    expect(restored.idempotencyKey, mutation.idempotencyKey);
    expect(restored.retryCount, 3);
    expect(restored.nextAttemptAt, mutation.nextAttemptAt);
    expect(restored.lastErrorCode, 'NETWORK_UNAVAILABLE');
    expect(restored.lastFailureAt, mutation.lastFailureAt);
  });
}
