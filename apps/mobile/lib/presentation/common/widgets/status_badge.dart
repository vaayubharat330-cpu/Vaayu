import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';

enum StatusBadgeType {
  online,
  offline,
  connecting,
  syncing,
  warning,
  danger,
  neutral,
}

/// Presentation-only status indicator badge.
/// Consumes a high-level presentation status rather than inspecting transport or network internals.
class StatusBadge extends StatelessWidget {
  final String label;
  final StatusBadgeType type;
  final bool showDot;
  final Color? customColor;

  const StatusBadge({
    super.key,
    required this.label,
    this.type = StatusBadgeType.neutral,
    this.showDot = true,
    this.customColor,
  });

  /// Factory helper for presentation connection states
  factory StatusBadge.connection({
    Key? key,
    required bool isConnected,
    bool isReconnecting = false,
  }) {
    if (isReconnecting) {
      return StatusBadge(
        key: key,
        label: 'Reconnecting',
        type: StatusBadgeType.connecting,
      );
    }
    return StatusBadge(
      key: key,
      label: isConnected ? 'Online' : 'Offline',
      type: isConnected ? StatusBadgeType.online : StatusBadgeType.offline,
    );
  }

  /// Factory helper for queue/sync states
  factory StatusBadge.sync({
    Key? key,
    required int pendingMutations,
  }) {
    if (pendingMutations == 0) {
      return StatusBadge(
        key: key,
        label: 'Synced',
        type: StatusBadgeType.online,
      );
    }
    return StatusBadge(
      key: key,
      label: 'Syncing ($pendingMutations)',
      type: StatusBadgeType.syncing,
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);

    final Color badgeColor = customColor ?? switch (type) {
      StatusBadgeType.online => colors.success,
      StatusBadgeType.offline => colors.danger,
      StatusBadgeType.connecting => colors.warning,
      StatusBadgeType.syncing => colors.secondary,
      StatusBadgeType.warning => colors.warning,
      StatusBadgeType.danger => colors.danger,
      StatusBadgeType.neutral => colors.textSecondary,
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: VaayuSpacing.sm * 1.25, vertical: VaayuSpacing.xs),
      decoration: BoxDecoration(
        color: badgeColor.withValues(alpha: 0.12),
        borderRadius: VaayuRadius.pillBorder,
        border: Border.all(
          color: badgeColor.withValues(alpha: 0.35),
          width: 1.0,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (showDot) ...[
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: badgeColor,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: VaayuSpacing.xs * 1.5),
          ],
          Text(
            label,
            style: TextStyle(
              color: badgeColor,
              fontWeight: FontWeight.w600,
              fontSize: 12,
              letterSpacing: 0.2,
            ),
          ),
        ],
      ),
    );
  }
}
