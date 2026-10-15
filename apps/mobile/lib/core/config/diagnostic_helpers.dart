/// Diagnostic & Development-Only Credential Provider.
/// Strictly gated: returns null if not running in development mode.
/// Zero embedded secrets: Development credentials must be supplied via external
/// configuration (--dart-define) or dynamic injection, never hardcoded in source.
library diagnostic_helpers;

import '../models/auth_session.dart';

class DiagnosticCredentials {
  /// Resolves development-only test customer session strictly gated to development mode.
  /// Zero JWT literals: Requires external token passed via parameter or --dart-define.
  /// Returns null if not running in development mode, or if no external token is provided.
  static AuthSession? getDevelopmentCustomerSession({
    required bool isDevelopment,
    String? externalToken,
    String? userId,
  }) {
    if (!isDevelopment) return null;

    const envToken = String.fromEnvironment('VAAYU_DEV_CUSTOMER_TOKEN');
    const envUserId = String.fromEnvironment('VAAYU_DEV_CUSTOMER_ID', defaultValue: 'usr_cust_dev_01');
    const envPhone = String.fromEnvironment('VAAYU_DEV_CUSTOMER_PHONE', defaultValue: '+919999900001');

    final token = externalToken ?? (envToken.isNotEmpty ? envToken : null);
    if (token == null || token.isEmpty) {
      return null;
    }

    final now = DateTime.now();
    return AuthSession(
      userId: userId ?? envUserId,
      token: token,
      role: 'CUSTOMER',
      name: 'Dev Customer',
      phone: envPhone,
      city: 'Hyderabad',
      issuedAt: now,
      expiresAt: now.add(const Duration(hours: 24)),
    );
  }

  /// Resolves development-only test driver session strictly gated to development mode.
  /// Zero JWT literals: Requires external token passed via parameter or --dart-define.
  /// Returns null if not running in development mode, or if no external token is provided.
  static AuthSession? getDevelopmentDriverSession({
    required bool isDevelopment,
    String? externalToken,
    String? userId,
  }) {
    if (!isDevelopment) return null;

    const envToken = String.fromEnvironment('VAAYU_DEV_DRIVER_TOKEN');
    const envUserId = String.fromEnvironment('VAAYU_DEV_DRIVER_ID', defaultValue: 'usr_drv_dev_01');
    const envPhone = String.fromEnvironment('VAAYU_DEV_DRIVER_PHONE', defaultValue: '+917842416560');

    final token = externalToken ?? (envToken.isNotEmpty ? envToken : null);
    if (token == null || token.isEmpty) {
      return null;
    }

    final now = DateTime.now();
    return AuthSession(
      userId: userId ?? envUserId,
      token: token,
      role: 'DRIVER',
      name: 'Dev Driver',
      phone: envPhone,
      city: 'Hyderabad',
      issuedAt: now,
      expiresAt: now.add(const Duration(hours: 24)),
    );
  }
}
