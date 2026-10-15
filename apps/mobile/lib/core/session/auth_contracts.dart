import 'session_manager.dart';
import '../errors/auth_exception.dart';

/// Contract for Authentication Flow & Token Lifecycle Operations
abstract class IAuthRepository {
  /// Request an OTP challenge for phone login/signup
  Future<Map<String, dynamic>> sendOtp({
    required String phone,
    required String appType, // 'CUSTOMER' or 'DRIVER'
    bool isSignUp = false,
    String? name,
  });

  /// Verify OTP challenge and establish authenticated session
  Future<void> verifyOtp({
    required String phone,
    required String otp,
    required String appType,
    bool isSignUp = false,
    String? name,
  });

  /// Invalidate and clear current session
  Future<void> logout();
}

/// Token Refresh & Auth Interceptor Contract for P15A.2 Network Transport
abstract class ITokenProvider {
  /// Returns the current bearer token, or throws if unauthenticated
  Future<String> getValidToken();

  /// Forces proactive refresh or re-authentication if token is expiring soon
  Future<String> refreshToken();
}

/// Concrete Token Provider adhering to SessionManager
class SessionTokenProvider implements ITokenProvider {
  final SessionManager _sessionManager;

  SessionTokenProvider({required SessionManager sessionManager})
      : _sessionManager = sessionManager;

  @override
  Future<String> getValidToken() async {
    final session = _sessionManager.currentSession;
    if (session == null || !_sessionManager.isAuthenticated) {
      throw const SessionNotFoundException();
    }

    if (session.isExpired) {
      throw const TokenExpiredException();
    }

    return session.token;
  }

  @override
  Future<String> refreshToken() async {
    final session = _sessionManager.currentSession;
    if (session == null) {
      throw const SessionNotFoundException();
    }

    // Handshake contract: In P15A.2, this invokes /api/auth/refresh if configured
    // or signals SessionStatus.expired for UI re-auth prompt.
    if (session.isExpired) {
      throw const TokenExpiredException();
    }

    return session.token;
  }
}
