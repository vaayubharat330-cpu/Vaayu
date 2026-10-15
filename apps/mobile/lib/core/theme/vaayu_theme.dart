import 'package:flutter/material.dart';
import 'vaayu_colors.dart';
import 'vaayu_tokens.dart';
import 'vaayu_typography.dart';

/// Central theme factory for the VAAYU application.
/// Produces Material 3 ThemeData with integrated VaayuColors ThemeExtension.
class VaayuTheme {
  /// Resolves the semantic color tokens from BuildContext, falling back to brightness defaults
  static VaayuColors colorsOf(BuildContext context) {
    return Theme.of(context).extension<VaayuColors>() ??
        (Theme.of(context).brightness == Brightness.dark ? VaayuColors.dark : VaayuColors.light);
  }

  /// Dark Theme (Default) - Deep Carbon surfaces with Electric Emerald & Cyan accents
  static ThemeData dark() {
    const colors = VaayuColors.dark;
    final textTheme = VaayuTypography.createTextTheme(colors.textPrimary, colors.textSecondary);

    final colorScheme = ColorScheme.dark(
      primary: colors.primary,
      onPrimary: colors.onPrimary,
      secondary: colors.secondary,
      onSecondary: colors.onSecondary,
      surface: colors.surface,
      onSurface: colors.textPrimary,
      error: colors.danger,
      onError: colors.onDanger,
      outline: colors.border,
    );

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: colors.background,
      textTheme: textTheme,
      extensions: const <ThemeExtension<dynamic>>[colors],
      appBarTheme: AppBarTheme(
        backgroundColor: colors.surface,
        foregroundColor: colors.textPrimary,
        elevation: VaayuElevation.flat,
        centerTitle: true,
        titleTextStyle: textTheme.titleLarge,
      ),
      cardTheme: CardThemeData(
        color: colors.surfaceElevated,
        elevation: VaayuElevation.low,
        shape: const RoundedRectangleBorder(
          borderRadius: VaayuRadius.lgBorder,
        ),
        margin: EdgeInsets.zero,
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: colors.primary,
          foregroundColor: colors.onPrimary,
          shape: const RoundedRectangleBorder(
            borderRadius: VaayuRadius.mdBorder,
          ),
          padding: VaayuSpacing.buttonPadding,
          textStyle: textTheme.labelLarge,
          elevation: VaayuElevation.flat,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: colors.textPrimary,
          side: BorderSide(color: colors.border, width: 1.5),
          shape: const RoundedRectangleBorder(
            borderRadius: VaayuRadius.mdBorder,
          ),
          padding: VaayuSpacing.buttonPadding,
          textStyle: textTheme.labelLarge,
        ),
      ),
      dividerTheme: DividerThemeData(
        color: colors.divider,
        thickness: 1,
        space: 1,
      ),
    );
  }

  /// Light Theme - Crisp white surfaces with deep emerald & slate contrast
  static ThemeData light() {
    const colors = VaayuColors.light;
    final textTheme = VaayuTypography.createTextTheme(colors.textPrimary, colors.textSecondary);

    final colorScheme = ColorScheme.light(
      primary: colors.primary,
      onPrimary: colors.onPrimary,
      secondary: colors.secondary,
      onSecondary: colors.onSecondary,
      surface: colors.surface,
      onSurface: colors.textPrimary,
      error: colors.danger,
      onError: colors.onDanger,
      outline: colors.border,
    );

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: colors.background,
      textTheme: textTheme,
      extensions: const <ThemeExtension<dynamic>>[colors],
      appBarTheme: AppBarTheme(
        backgroundColor: colors.surface,
        foregroundColor: colors.textPrimary,
        elevation: VaayuElevation.flat,
        centerTitle: true,
        titleTextStyle: textTheme.titleLarge,
      ),
      cardTheme: CardThemeData(
        color: colors.surfaceElevated,
        elevation: VaayuElevation.low,
        shape: const RoundedRectangleBorder(
          borderRadius: VaayuRadius.lgBorder,
        ),
        margin: EdgeInsets.zero,
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: colors.primary,
          foregroundColor: colors.onPrimary,
          shape: const RoundedRectangleBorder(
            borderRadius: VaayuRadius.mdBorder,
          ),
          padding: VaayuSpacing.buttonPadding,
          textStyle: textTheme.labelLarge,
          elevation: VaayuElevation.flat,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: colors.textPrimary,
          side: BorderSide(color: colors.border, width: 1.5),
          shape: const RoundedRectangleBorder(
            borderRadius: VaayuRadius.mdBorder,
          ),
          padding: VaayuSpacing.buttonPadding,
          textStyle: textTheme.labelLarge,
        ),
      ),
      dividerTheme: DividerThemeData(
        color: colors.divider,
        thickness: 1,
        space: 1,
      ),
    );
  }
}
