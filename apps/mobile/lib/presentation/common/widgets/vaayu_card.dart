import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';

/// Standardized card component providing consistent background, border, elevation, and optional tap interaction.
class VaayuCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry margin;
  final VoidCallback? onTap;
  final Color? backgroundColor;
  final Color? borderColor;
  final double? elevation;
  final BorderRadius? borderRadius;

  const VaayuCard({
    super.key,
    required this.child,
    this.padding = VaayuSpacing.cardPadding,
    this.margin = EdgeInsets.zero,
    this.onTap,
    this.backgroundColor,
    this.borderColor,
    this.elevation,
    this.borderRadius,
  });

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);
    final effectiveRadius = borderRadius ?? VaayuRadius.lgBorder;
    final effectiveBg = backgroundColor ?? colors.surfaceElevated;
    final effectiveBorder = borderColor ?? colors.border;

    final disableAnimations = MediaQuery.disableAnimationsOf(context);

    Widget cardContent = AnimatedContainer(
      duration: disableAnimations ? Duration.zero : const Duration(milliseconds: 200),
      curve: Curves.easeOutCubic,
      padding: padding,
      decoration: BoxDecoration(
        color: effectiveBg,
        borderRadius: effectiveRadius,
        border: Border.all(color: effectiveBorder, width: 1.0),
      ),
      child: child,
    );

    if (onTap != null) {
      cardContent = Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: effectiveRadius,
          splashColor: colors.primary.withValues(alpha: 0.12),
          highlightColor: colors.primary.withValues(alpha: 0.05),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48.0, minWidth: 48.0),
            child: cardContent,
          ),
        ),
      );
    }

    if (margin != EdgeInsets.zero) {
      cardContent = Padding(
        padding: margin,
        child: cardContent,
      );
    }

    return cardContent;
  }
}
