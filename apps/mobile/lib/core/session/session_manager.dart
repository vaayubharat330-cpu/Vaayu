import 'dart:async';
import 'dart:convert';

import '../errors/auth_exception.dart';
import '../models/auth_session.dart';
import '../security/secure_storage_service.dart';
import 'auth_contracts.dart';

/// Lifecycle States for the Mobile Authenticated Session
enum SessionStatus {
  unauthenticated,
  authenticated,
  expired,
  restoring,
}

/// Core Session Manager for VAAYU Mobile Client
/// Responsible for:
/// - Secure credential persistence & wiping
/// - Cold start session restoration
/// - Role isolation (preventing Customer and Driver cross-pollution)
/// - Expiration detection & proactive refresh gating
class SessionManager implements ITokenProvider {
  static const String keyActiveSession = 'vaayu_active_session';
  static const String keyActiveRole = 'vaayu_active_role';
  static const String keyDeviceIdentifier = 'vaayu_device_id';

  final ISecureStorageService _storage;
  final StreamController<SessionStatus> _statusController = StreamController<SessionStatus>.broadcast();

  AuthSession? _currentSession;
  SessionStatus _status = SessionStatus.unauthenticated;

  SessionManager({required ISecureStorageService storage, ISecureStorageService? storageService})
      : _storage = storageService ?? storage;

  /// Current In-Memory Active Session
  AuthSession? get currentSession => _currentSession;

  /// Current Session Status
  SessionStatus get status => _status;

  /// Reactive Session Status Stream
  Stream<SessionStatus> get statusStream => _statusController.stream;
  Stream<AuthSession?> get sessionStream => _statusController.stream.map((_) => _currentSession);

  /// Whether the user is actively authenticated with an unexpired session
  bool get isAuthenticated =>
      _status == SessionStatus.authenticated && _currentSession != null && !_currentSession!.isExpired;

  /// Initializes / Restores session from secure storage upon App Cold Startup
  Future<SessionStatus> restoreSession() async {
    _status = SessionStatus.restoring;
    _statusController.add(_status);

    try {
      final rawJson = await _storage.read(key: keyActiveSession);
      if (rawJson == null || rawJson.isEmpty) {
        _currentSession = null;
        _status = SessionStatus.unauthenticated;
        _statusController.add(_status);
        return _status;
      }

      final sessionMap = jsonDecode(rawJson) as Map<String, dynamic>;
      final session = AuthSession.fromJson(sessionMap);

      if (session.isExpired) {
        // Stale or expired token found: mark expired but preserve reference for refresh attempt
        _currentSession = session;
        _status = SessionStatus.expired;
        _statusController.add(_status);
        return _status;
      }

      _currentSession = session;
      _status = SessionStatus.authenticated;
      _statusController.add(_status);
      return _status;
    } catch (e) {
      // In case of corrupt or tampered storage, fail closed and wipe
      await clearSession();
      _status = SessionStatus.unauthenticated;
      _statusController.add(_status);
      return _status;
    }
  }

  /// Establishes a new authenticated session (Login / Sign-up)
  Future<void> establishSession(AuthSession session) async {
    if (session.isExpired) {
      throw const TokenExpiredException(message: 'Cannot establish a session with an expired token.');
    }

    // Role Isolation: If switching roles (e.g. Customer to Driver), ensure clean storage state
    if (_currentSession != null && _currentSession!.role != session.role) {
      await clearSession();
    }

    _currentSession = session;
    await _storage.write(key: keyActiveSession, value: jsonEncode(session.toJson()));
    await _storage.write(key: keyActiveRole, value: session.role);

    _status = SessionStatus.authenticated;
    _statusController.add(_status);
  }

  /// Updates or refreshes the active session token
  Future<void> updateToken(String newToken) async {
    if (_currentSession == null) {
      throw const SessionNotFoundException();
    }

    final updatedSession = AuthSession.fromJwt(newToken, additionalProfile: {
      'name': _currentSession!.name,
      'phone': _currentSession!.phone,
      'city': _currentSession!.city,
    });

    await establishSession(updatedSession);
  }

  /// Ensures current session possesses the required role
  void requireRole(String expectedRole) {
    if (!isAuthenticated) {
      throw const SessionNotFoundException();
    }
    if (_currentSession!.role != expectedRole.toUpperCase()) {
      throw RoleMismatchException(
        expectedRole: expectedRole.toUpperCase(),
        actualRole: _currentSession!.role,
      );
    }
  }

  /// Terminates the current session and purges all credentials from secure storage
  Future<void> clearSession() async {
    _currentSession = null;
    await _storage.delete(key: keyActiveSession);
    await _storage.delete(key: keyActiveRole);
    _status = SessionStatus.unauthenticated;
    _statusController.add(_status);
  }

  /// ITokenProvider Implementation
  @override
  Future<String> getValidToken() async {
    if (!isAuthenticated) throw const SessionNotFoundException();
    return _currentSession!.token;
  }

  @override
  Future<String> refreshToken() async {
    if (!isAuthenticated) throw const SessionNotFoundException();
    return _currentSession!.token;
  }

  /// Clean disposal of stream controllers
  void dispose() {
    _statusController.close();
  }
}
