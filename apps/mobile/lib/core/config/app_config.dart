/// Environment & Multi-Stage Deployment Configuration.
/// Supports compile-time --dart-define overrides with secure, fail-closed production defaults.
library app_config;

import 'package:flutter/foundation.dart';

enum Environment {
  development,
  staging,
  production,
}

class AppConfig {
  final Environment environment;
  final String apiBaseUrl;
  final String wsBaseUrl;
  final bool enableDiagnostics;
  final bool logNetworkTraffic;
  final Duration connectTimeout;
  final Duration receiveTimeout;

  const AppConfig({
    required this.environment,
    required this.apiBaseUrl,
    required this.wsBaseUrl,
    this.enableDiagnostics = false,
    this.logNetworkTraffic = false,
    this.connectTimeout = const Duration(seconds: 10),
    this.receiveTimeout = const Duration(seconds: 10),
  });

  bool get isProduction => environment == Environment.production;
  bool get isStaging => environment == Environment.staging;
  bool get isDevelopment => environment == Environment.development;

  /// Resolves active configuration dynamically using compile-time --dart-define
  /// or deterministic fail-closed environment defaults.
  ///
  /// In release mode (`kReleaseMode`), the configuration fails closed:
  /// - Default environment is `production` (never silently falls back to development).
  /// - Attempting to force `development` in release builds throws a [StateError].
  /// - In production, endpoints must use TLS (`https://` and `wss://`).
  factory AppConfig.fromEnvironment({bool? isReleaseModeOverride}) {
    final isRelease = isReleaseModeOverride ?? kReleaseMode;

    const envString = String.fromEnvironment('VAAYU_ENV');
    final Environment env;
    if (envString.isNotEmpty) {
      env = parseEnvironment(envString);
      if (isRelease && env == Environment.development) {
        throw StateError(
          'Security Violation: Cannot run development environment in a release build. '
          'Release builds must target production or staging.',
        );
      }
    } else {
      env = isRelease ? Environment.production : Environment.development;
    }

    const overrideApi = String.fromEnvironment('VAAYU_API_BASE_URL');
    const overrideWs = String.fromEnvironment('VAAYU_WS_BASE_URL');
    const overrideDiagnostics = bool.fromEnvironment('VAAYU_ENABLE_DIAGNOSTICS', defaultValue: false);

    final defaultApiUrl = switch (env) {
      Environment.production => 'https://api.vaayu.in',
      Environment.staging => 'https://staging-api.vaayu.in',
      Environment.development => 'http://10.0.2.2:4000',
    };

    final defaultWsUrl = switch (env) {
      Environment.production => 'wss://api.vaayu.in/ws',
      Environment.staging => 'wss://staging-api.vaayu.in/ws',
      Environment.development => 'ws://10.0.2.2:4000/ws',
    };

    final apiBaseUrl = overrideApi.isNotEmpty ? overrideApi : defaultApiUrl;
    final wsBaseUrl = overrideWs.isNotEmpty ? overrideWs : defaultWsUrl;

    // Fail-closed TLS requirement for production:
    if (env == Environment.production) {
      if (!apiBaseUrl.startsWith('https://')) {
        throw StateError(
          'Security Violation: Production apiBaseUrl must use HTTPS scheme. Got: $apiBaseUrl',
        );
      }
      if (!wsBaseUrl.startsWith('wss://')) {
        throw StateError(
          'Security Violation: Production wsBaseUrl must use WSS scheme. Got: $wsBaseUrl',
        );
      }
    }

    // Diagnostics are strictly disabled in production regardless of flags
    final enableDiagnostics = env == Environment.production ? false : overrideDiagnostics;

    return AppConfig(
      environment: env,
      apiBaseUrl: apiBaseUrl,
      wsBaseUrl: wsBaseUrl,
      enableDiagnostics: enableDiagnostics,
      logNetworkTraffic: env == Environment.development,
    );
  }

  /// Preset for explicit development environment
  factory AppConfig.development({
    String apiBaseUrl = 'http://10.0.2.2:4000',
    String wsBaseUrl = 'ws://10.0.2.2:4000/ws',
    bool enableDiagnostics = true,
  }) =>
      AppConfig(
        environment: Environment.development,
        apiBaseUrl: apiBaseUrl,
        wsBaseUrl: wsBaseUrl,
        enableDiagnostics: enableDiagnostics,
        logNetworkTraffic: true,
      );

  /// Preset for explicit staging environment
  factory AppConfig.staging({
    String apiBaseUrl = 'https://staging-api.vaayu.in',
    String wsBaseUrl = 'wss://staging-api.vaayu.in/ws',
    bool enableDiagnostics = true,
  }) =>
      AppConfig(
        environment: Environment.staging,
        apiBaseUrl: apiBaseUrl,
        wsBaseUrl: wsBaseUrl,
        enableDiagnostics: enableDiagnostics,
        logNetworkTraffic: false,
      );

  /// Preset for explicit production environment (hardened, fail-closed, TLS only, zero diagnostics)
  factory AppConfig.production({
    String apiBaseUrl = 'https://api.vaayu.in',
    String wsBaseUrl = 'wss://api.vaayu.in/ws',
  }) {
    if (!apiBaseUrl.startsWith('https://')) {
      throw StateError('Security Violation: Production apiBaseUrl must use HTTPS scheme. Got: $apiBaseUrl');
    }
    if (!wsBaseUrl.startsWith('wss://')) {
      throw StateError('Security Violation: Production wsBaseUrl must use WSS scheme. Got: $wsBaseUrl');
    }
    return AppConfig(
      environment: Environment.production,
      apiBaseUrl: apiBaseUrl,
      wsBaseUrl: wsBaseUrl,
      enableDiagnostics: false,
      logNetworkTraffic: false,
    );
  }

  static Environment parseEnvironment(String value) {
    switch (value.toLowerCase().trim()) {
      case 'production':
      case 'prod':
        return Environment.production;
      case 'staging':
      case 'stage':
        return Environment.staging;
      case 'development':
      case 'dev':
      default:
        return Environment.development;
    }
  }
}
