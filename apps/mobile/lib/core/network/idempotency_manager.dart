import 'dart:math';

/// Contract for Idempotency Key Tracking & Retry Reusability
/// Invariant: Retried requests MUST reuse the original idempotency key.
/// New mutations receive distinct keys. GET/HEAD/OPTIONS requests do not attach keys.
abstract class IIdempotencyManager {
  /// Generates a new UUIDv4 idempotency key or retrieves the active key for a given request intent ID
  String getOrCreateKey({required String intentId});

  /// Retrieves the existing key for a retry attempt
  String? getKey({required String intentId});

  /// Generates a fresh UUIDv4 string
  String generateUuidV4();

  /// Releases the key after deterministic completion
  void releaseKey({required String intentId});

  /// Clears all keys upon session termination
  void clear();
}

class InMemoryIdempotencyManager implements IIdempotencyManager {
  final Map<String, String> _activeKeys = {};
  final Random _random = Random.secure();

  InMemoryIdempotencyManager();

  @override
  String generateUuidV4() {
    final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10
    final hexDigits = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).toList();
    return '${hexDigits.sublist(0, 4).join()}-${hexDigits.sublist(4, 6).join()}-${hexDigits.sublist(6, 8).join()}-${hexDigits.sublist(8, 10).join()}-${hexDigits.sublist(10, 16).join()}';
  }

  @override
  String getOrCreateKey({required String intentId}) {
    if (_activeKeys.containsKey(intentId)) {
      return _activeKeys[intentId]!;
    }
    final key = generateUuidV4();
    _activeKeys[intentId] = key;
    return key;
  }

  @override
  String? getKey({required String intentId}) {
    return _activeKeys[intentId];
  }

  @override
  void releaseKey({required String intentId}) {
    _activeKeys.remove(intentId);
  }

  @override
  void clear() {
    _activeKeys.clear();
  }
}

typedef IdempotencyManager = InMemoryIdempotencyManager;
