import 'package:flutter/material.dart';

/// Semantic color tokens for the VAAYU Design System.
/// Provides centralized access to brand, semantic, surface, and high-contrast color roles.
class VaayuColors extends ThemeExtension<VaayuColors> {
  final Color primary;
  final Color onPrimary;
  final Color secondary;
  final Color onSecondary;
  final Color surface;
  final Color surfaceElevated;
  final Color background;
  final Color onBackground;
  final Color success;
  final Color onSuccess;
  final Color warning;
  final Color onWarning;
  final Color danger;
  final Color onDanger;
  final Color textPrimary;
  final Color textSecondary;
  final Color textTertiary;
  final Color border;
  final Color divider;

  const VaayuColors({
    required this.primary,
    required this.onPrimary,
    required this.secondary,
    required this.onSecondary,
    required this.surface,
    required this.surfaceElevated,
    required this.background,
    required this.onBackground,
    required this.success,
    required this.onSuccess,
    required this.warning,
    required this.onWarning,
    required this.danger,
    required this.onDanger,
    required this.textPrimary,
    required this.textSecondary,
    required this.textTertiary,
    required this.border,
    required this.divider,
  });

  /// Dark mode palette (Default: Deep Carbon surfaces with Electric Emerald & Cyan accents)
  static const dark = VaayuColors(
    primary: Color(0xFF00C853), // Electric Emerald
    onPrimary: Color(0xFF000000),
    secondary: Color(0xFF00E5FF), // Electric Cyan
    onSecondary: Color(0xFF000000),
    surface: Color(0xFF1E1E1E), // Deep Carbon surface
    surfaceElevated: Color(0xFF2A2A2A), // Elevated card/sheet surface
    background: Color(0xFF121212), // Dark Slate base background
    onBackground: Color(0xFFFFFFFF),
    success: Color(0xFF00E676),
    onSuccess: Color(0xFF000000),
    warning: Color(0xFFFFD600), // High visibility amber
    onWarning: Color(0xFF000000),
    danger: Color(0xFFFF5252), // High contrast coral red
    onDanger: Color(0xFFFFFFFF),
    textPrimary: Color(0xFFF5F5F5),
    textSecondary: Color(0xFFB8C4CE), // Enhanced cool silver slate (7.5:1 contrast)
    textTertiary: Color(0xFF8E9BA8), // High legibility muted label (5.2:1 contrast, WCAG AA compliant)
    border: Color(0xFF383E46), // Crisp dark-mode boundary definition
    divider: Color(0xFF2C3238),
  );

  /// Light mode palette (High-contrast crisp white surfaces and neutral slate grays)
  static const light = VaayuColors(
    primary: Color(0xFF00893A), // Deep emerald for AAA text/surface contrast
    onPrimary: Color(0xFFFFFFFF),
    secondary: Color(0xFF00838F), // Deep cyan
    onSecondary: Color(0xFFFFFFFF),
    surface: Color(0xFFFFFFFF),
    surfaceElevated: Color(0xFFF7F9FC),
    background: Color(0xFFF0F4F8),
    onBackground: Color(0xFF121212),
    success: Color(0xFF00893A),
    onSuccess: Color(0xFFFFFFFF),
    warning: Color(0xFFF57F17),
    onWarning: Color(0xFFFFFFFF),
    danger: Color(0xFFD32F2F),
    onDanger: Color(0xFFFFFFFF),
    textPrimary: Color(0xFF1A1A1A),
    textSecondary: Color(0xFF5A6672),
    textTertiary: Color(0xFF7E8B96),
    border: Color(0xFFE0E0E0),
    divider: Color(0xFFEEEEEE),
  );

  @override
  ThemeExtension<VaayuColors> copyWith({
    Color? primary,
    Color? onPrimary,
    Color? secondary,
    Color? onSecondary,
    Color? surface,
    Color? surfaceElevated,
    Color? background,
    Color? onBackground,
    Color? success,
    Color? onSuccess,
    Color? warning,
    Color? onWarning,
    Color? danger,
    Color? onDanger,
    Color? textPrimary,
    Color? textSecondary,
    Color? textTertiary,
    Color? border,
    Color? divider,
  }) {
    return VaayuColors(
      primary: primary ?? this.primary,
      onPrimary: onPrimary ?? this.onPrimary,
      secondary: secondary ?? this.secondary,
      onSecondary: onSecondary ?? this.onSecondary,
      surface: surface ?? this.surface,
      surfaceElevated: surfaceElevated ?? this.surfaceElevated,
      background: background ?? this.background,
      onBackground: onBackground ?? this.onBackground,
      success: success ?? this.success,
      onSuccess: onSuccess ?? this.onSuccess,
      warning: warning ?? this.warning,
      onWarning: onWarning ?? this.onWarning,
      danger: danger ?? this.danger,
      onDanger: onDanger ?? this.onDanger,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      textTertiary: textTertiary ?? this.textTertiary,
      border: border ?? this.border,
      divider: divider ?? this.divider,
    );
  }

  @override
  ThemeExtension<VaayuColors> lerp(ThemeExtension<VaayuColors>? other, double t) {
    if (other is! VaayuColors) return this;
    return VaayuColors(
      primary: Color.lerp(primary, other.primary, t)!,
      onPrimary: Color.lerp(onPrimary, other.onPrimary, t)!,
      secondary: Color.lerp(secondary, other.secondary, t)!,
      onSecondary: Color.lerp(onSecondary, other.onSecondary, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surfaceElevated: Color.lerp(surfaceElevated, other.surfaceElevated, t)!,
      background: Color.lerp(background, other.background, t)!,
      onBackground: Color.lerp(onBackground, other.onBackground, t)!,
      success: Color.lerp(success, other.success, t)!,
      onSuccess: Color.lerp(onSuccess, other.onSuccess, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      onWarning: Color.lerp(onWarning, other.onWarning, t)!,
      danger: Color.lerp(danger, other.danger, t)!,
      onDanger: Color.lerp(onDanger, other.onDanger, t)!,
      textPrimary: Color.lerp(textPrimary, other.textPrimary, t)!,
      textSecondary: Color.lerp(textSecondary, other.textSecondary, t)!,
      textTertiary: Color.lerp(textTertiary, other.textTertiary, t)!,
      border: Color.lerp(border, other.border, t)!,
      divider: Color.lerp(divider, other.divider, t)!,
    );
  }
}
