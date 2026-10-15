import 'dart:convert';
import '../errors/auth_exception.dart';

/// Immutable Representation of an Authenticated VAAYU Session
class AuthSession {
  final String userId;
  final String token;
  final String role; // 'CUSTOMER', 'DRIVER', 'MERCHANT', 'ADMIN'
  final String name;
  final String phone;
  final String city;
  final String? tenantId;
  final DateTime issuedAt;
  final DateTime expiresAt;

  const AuthSession({
    required this.userId,
    required this.token,
    required this.role,
    required this.name,
    required this.phone,
    required this.city,
    this.tenantId,
    required this.issuedAt,
    required this.expiresAt,
  });

  /// Check whether the session JWT has physically expired
  bool get isExpired => DateTime.now().isAfter(expiresAt);

  /// Check whether token expires within a specified buffer duration (default 60 seconds)
  bool isExpiringSoon({Duration buffer = const Duration(seconds: 60)}) {
    return DateTime.now().add(buffer).isAfter(expiresAt);
  }

  /// Parses an authenticated session from a raw JWT token and optional profile metadata
  factory AuthSession.fromJwt(String token, {Map<String, dynamic>? additionalProfile}) {
    final parts = token.split('.');
    if (parts.length != 3) {
      throw const TokenMalformedException(message: 'JWT must consist of exactly three dot-separated segments.');
    }

    try {
      final normalizedPayload = base64Url.normalize(parts[1]);
      final payloadBytes = base64Url.decode(normalizedPayload);
      final payloadMap = jsonDecode(utf8.decode(payloadBytes)) as Map<String, dynamic>;

      final expSeconds = payloadMap['exp'] as int?;
      final iatSeconds = payloadMap['iat'] as int?;

      if (expSeconds == null) {
        throw const TokenMalformedException(message: 'JWT payload is missing mandatory "exp" claim.');
      }

      final expiresAt = DateTime.fromMillisecondsSinceEpoch(expSeconds * 1000);
      final issuedAt = iatSeconds != null
          ? DateTime.fromMillisecondsSinceEpoch(iatSeconds * 1000)
          : DateTime.now();

      return AuthSession(
        userId: payloadMap['id']?.toString() ?? payloadMap['userId']?.toString() ?? '',
        token: token,
        role: (payloadMap['role']?.toString() ?? 'CUSTOMER').toUpperCase(),
        name: additionalProfile?['name']?.toString() ?? payloadMap['name']?.toString() ?? 'Vaayu User',
        phone: additionalProfile?['phone']?.toString() ?? payloadMap['phone']?.toString() ?? '',
        city: additionalProfile?['city']?.toString() ?? payloadMap['city']?.toString() ?? 'Hyderabad',
        tenantId: payloadMap['tenantId']?.toString() ?? payloadMap['merchantId']?.toString(),
        issuedAt: issuedAt,
        expiresAt: expiresAt,
      );
    } catch (e) {
      if (e is AuthException) rethrow;
      throw TokenMalformedException(message: 'Failed to parse JWT payload: $e');
    }
  }

  /// Serializes the session metadata for secure storage (excluding raw secret material)
  Map<String, dynamic> toJson() => {
        'userId': userId,
        'token': token,
        'role': role,
        'name': name,
        'phone': phone,
        'city': city,
        'tenantId': tenantId,
        'issuedAt': issuedAt.toIso8601String(),
        'expiresAt': expiresAt.toIso8601String(),
      };

  factory AuthSession.fromJson(Map<String, dynamic> json) => AuthSession(
        userId: json['userId'] as String,
        token: json['token'] as String,
        role: json['role'] as String,
        name: json['name'] as String,
        phone: json['phone'] as String,
        city: json['city'] as String,
        tenantId: json['tenantId'] as String?,
        issuedAt: DateTime.parse(json['issuedAt'] as String),
        expiresAt: DateTime.parse(json['expiresAt'] as String),
      );
}
