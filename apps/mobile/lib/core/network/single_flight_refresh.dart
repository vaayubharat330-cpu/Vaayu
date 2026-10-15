import 'dart:async';
import '../errors/auth_exception.dart';
import '../session/session_manager.dart';

/// Single-Flight Token Refresh Coordinator
/// Invariant: Multiple concurrent 401s coalesce into exactly ONE refresh flight.
/// All waiting requests await that single flight before retrying or failing.
class SingleFlightRefreshCoordinator {
  final SessionManager _sessionManager;
  final Future<String> Function() _refreshCall;

  Completer<String>? _inFlightRefresh;

  SingleFlightRefreshCoordinator({
    required SessionManager sessionManager,
    required Future<String> Function() refreshCall,
  })  : _sessionManager = sessionManager,
        _refreshCall = refreshCall;

  bool get isRefreshing => _inFlightRefresh != null && !_inFlightRefresh!.isCompleted;

  Future<String> refreshToken() async {
    // If a refresh is already in-flight, await the ongoing future
    if (_inFlightRefresh != null) {
      return _inFlightRefresh!.future;
    }

    final completer = Completer<String>();
    completer.future.ignore();
    _inFlightRefresh = completer;

    try {
      final newToken = await _refreshCall();
      await _sessionManager.updateToken(newToken);
      completer.complete(newToken);
      return newToken;
    } catch (e) {
      // Refresh failed: terminate session and notify waiting requests
      await _sessionManager.clearSession();
      final exception = TokenExpiredException(
        message: 'Token refresh failed. Session terminated.',
        details: e.toString(),
      );
      completer.completeError(exception);
      throw exception;
    } finally {
      _inFlightRefresh = null;
    }
  }
}
