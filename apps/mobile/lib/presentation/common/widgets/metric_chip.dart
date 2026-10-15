import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';

/// Compact metric chip displaying key ride/operational statistics.
class MetricChip extends StatelessWidget {
  final IconData? icon;
  final String? label;
  final String value;
  final Color? accentColor;
  final VoidCallback? onTap;

  const MetricChip({
    super.key,
    this.icon,
    this.label,
    required this.value,
    this.accentColor,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);
    final iconAndValueColor = accentColor ?? colors.textPrimary;

    Widget chipContent = Container(
      padding: VaayuSpacing.chipPadding,
      decoration: BoxDecoration(
        color: colors.surfaceElevated,
        borderRadius: VaayuRadius.pillBorder,
        border: Border.all(color: colors.border, width: 1.0),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 14, color: iconAndValueColor),
            const SizedBox(width: VaayuSpacing.xs),
          ],
          if (label != null) ...[
            Text(
              '$label: ',
              style: TextStyle(
                color: colors.textSecondary,
                fontSize: 12,
                fontWeight: FontWeight.w500,
              ),
            ),
          ],
          Text(
            value,
            style: TextStyle(
              color: iconAndValueColor,
              fontSize: 12,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.1,
            ),
          ),
        ],
      ),
    );

    if (onTap != null) {
      chipContent = InkWell(
        onTap: onTap,
        borderRadius: VaayuRadius.pillBorder,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48.0, minWidth: 48.0),
          child: Center(
            widthFactor: 1.0,
            heightFactor: 1.0,
            child: chipContent,
          ),
        ),
      );
    }

    return chipContent;
  }
}
