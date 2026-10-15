import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';

enum VaayuButtonVariant {
  primary,
  secondary,
  danger,
  outlined,
}

/// Reusable branded button supporting loading, disabled, and icon variants.
/// Follows semantic color tokens without hardcoding raw colors.
class VaayuButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final VaayuButtonVariant variant;
  final bool isLoading;
  final bool isDisabled;
  final IconData? leadingIcon;
  final IconData? trailingIcon;
  final bool isFullWidth;
  final double height;

  const VaayuButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.variant = VaayuButtonVariant.primary,
    this.isLoading = false,
    this.isDisabled = false,
    this.leadingIcon,
    this.trailingIcon,
    this.isFullWidth = true,
    this.height = 48.0,
  });

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);
    final effectiveEnabled = !isDisabled && !isLoading && onPressed != null;

    final (Color bgColor, Color fgColor, BorderSide? border) = switch (variant) {
      VaayuButtonVariant.primary => (
          effectiveEnabled ? colors.primary : colors.surfaceElevated,
          effectiveEnabled ? colors.onPrimary : colors.textTertiary,
          null,
        ),
      VaayuButtonVariant.secondary => (
          effectiveEnabled ? colors.secondary : colors.surfaceElevated,
          effectiveEnabled ? colors.onSecondary : colors.textTertiary,
          null,
        ),
      VaayuButtonVariant.danger => (
          effectiveEnabled ? colors.danger : colors.surfaceElevated,
          effectiveEnabled ? colors.onDanger : colors.textTertiary,
          null,
        ),
      VaayuButtonVariant.outlined => (
          Colors.transparent,
          effectiveEnabled ? colors.textPrimary : colors.textTertiary,
          BorderSide(
            color: effectiveEnabled ? colors.border : colors.border.withValues(alpha: 0.5),
            width: 1.5,
          ),
        ),
    };

    Widget content;
    if (isLoading) {
      content = SizedBox(
        key: const ValueKey('vaayu_btn_loading'),
        height: 20,
        width: 20,
        child: CircularProgressIndicator(
          strokeWidth: 2.5,
          valueColor: AlwaysStoppedAnimation<Color>(fgColor),
        ),
      );
    } else {
      content = Row(
        key: const ValueKey('vaayu_btn_content'),
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (leadingIcon != null) ...[
            Icon(leadingIcon, size: 18, color: fgColor),
            const SizedBox(width: VaayuSpacing.sm),
          ],
          Flexible(
            child: Text(
              label,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: fgColor,
                fontWeight: FontWeight.w600,
                fontSize: 15,
                letterSpacing: 0.2,
              ),
            ),
          ),
          if (trailingIcon != null) ...[
            const SizedBox(width: VaayuSpacing.sm),
            Icon(trailingIcon, size: 18, color: fgColor),
          ],
        ],
      );
    }

    final disableAnimations = MediaQuery.disableAnimationsOf(context);

    final animatedContent = disableAnimations
        ? content
        : AnimatedSwitcher(
            duration: const Duration(milliseconds: 200),
            switchInCurve: Curves.easeOutCubic,
            switchOutCurve: Curves.easeInCubic,
            child: content,
          );

    final buttonWidget = AnimatedContainer(
      duration: disableAnimations ? Duration.zero : const Duration(milliseconds: 200),
      curve: Curves.easeOutCubic,
      decoration: BoxDecoration(
        color: bgColor,
        borderRadius: VaayuRadius.mdBorder,
        border: border != null ? Border.fromBorderSide(border) : null,
      ),
      child: Material(
        color: Colors.transparent,
        shape: const RoundedRectangleBorder(
          borderRadius: VaayuRadius.mdBorder,
        ),
        child: InkWell(
          onTap: effectiveEnabled ? onPressed : null,
          borderRadius: VaayuRadius.mdBorder,
          splashColor: fgColor.withValues(alpha: 0.15),
          highlightColor: fgColor.withValues(alpha: 0.08),
          child: Container(
            constraints: BoxConstraints(
              minHeight: height,
              minWidth: isFullWidth ? double.infinity : 48.0,
            ),
            padding: VaayuSpacing.buttonPadding,
            alignment: Alignment.center,
            child: animatedContent,
          ),
        ),
      ),
    );

    if (isFullWidth) {
      return SizedBox(
        width: double.infinity,
        child: buttonWidget,
      );
    }

    return buttonWidget;
  }
}
