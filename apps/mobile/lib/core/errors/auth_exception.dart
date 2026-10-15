/// Standardized Authentication and Session Exception Model for VAAYU Mobile
class AuthException implements Exception {
  final String code;
  final String message;
  final dynamic details;

  const AuthException({
    required this.code,
    required this.message,
    this.details,
  });

  @override
  String toString() => 'AuthException(code: $code, message: $message, details: $details)';
}

class TokenExpiredException extends AuthException {
  const TokenExpiredException({
    super.message = 'The session token has expired. Please re-authenticate.',
    super.details,
  }) : super(code: 'TOKEN_EXPIRED');
}

class TokenMalformedException extends AuthException {
  const TokenMalformedException({
    super.message = 'The session token is structurally malformed or un-parseable.',
    super.details,
  }) : super(code: 'TOKEN_MALFORMED');
}

class SessionNotFoundException extends AuthException {
  const SessionNotFoundException({
    super.message = 'No active authenticated session was found in secure storage.',
    super.details,
  }) : super(code: 'SESSION_NOT_FOUND');
}

class RoleMismatchException extends AuthException {
  const RoleMismatchException({
    required String expectedRole,
    required String actualRole,
  }) : super(
          code: 'ROLE_MISMATCH',
          message: 'Active session role ($actualRole) does not match required role ($expectedRole).',
        );
}
