import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Abstract Storage Contract Decoupling the App from flutter_secure_storage
/// This allows clean unit testing without native platform channels (Android Keystore / iOS Keychain).
abstract class ISecureStorageService {
  /// Reads a single value by key
  Future<String?> read({required String key});

  /// Writes a single key-value pair
  Future<void> write({required String key, required String value});

  /// Deletes a single key
  Future<void> delete({required String key});

  /// Wipes all stored credentials and session data
  Future<void> deleteAll();

  /// Checks if a key exists
  Future<bool> containsKey({required String key});
}

/// In-Memory Implementation for Unit Testing and Non-Platform Harnesses
class InMemorySecureStorageService implements ISecureStorageService {
  final Map<String, String> _store = {};

  @override
  Future<String?> read({required String key}) async {
    return _store[key];
  }

  @override
  Future<void> write({required String key, required String value}) async {
    _store[key] = value;
  }

  @override
  Future<void> delete({required String key}) async {
    _store.remove(key);
  }

  @override
  Future<void> deleteAll() async {
    _store.clear();
  }

  @override
  Future<bool> containsKey({required String key}) async {
    return _store.containsKey(key);
  }
}

/// Native Hardware Keystore Implementation using flutter_secure_storage
class FlutterSecureStorageService implements ISecureStorageService {
  final FlutterSecureStorage _storage;

  FlutterSecureStorageService({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  @override
  Future<String?> read({required String key}) => _storage.read(key: key);

  @override
  Future<void> write({required String key, required String value}) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete({required String key}) => _storage.delete(key: key);

  @override
  Future<void> deleteAll() => _storage.deleteAll();

  @override
  Future<bool> containsKey({required String key}) =>
      _storage.containsKey(key: key);
}

