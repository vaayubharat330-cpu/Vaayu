/// E4.1: Exception-First Incident Wall for VAAYU Operations Cockpit.
/// Displays high-priority fleet alerts, stalled dispatches, and signal loss incidents
/// with direct operator command CTAs.
library operations_incident_wall;

import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_colors.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../../domain/operations/operations_models.dart';
import '../../common/widgets/status_badge.dart';
import '../../common/widgets/vaayu_button.dart';
import '../../common/widgets/vaayu_card.dart';

class OperationsIncidentWall extends StatelessWidget {
  final List<OperationalAlert> alerts;
  final void Function(String orderId)? onAssignDriver;
  final void Function(String orderId)? onRedispatch;
  final void Function(String orderId)? onCancelOverride;

  const OperationsIncidentWall({
    super.key,
    required this.alerts,
    this.onAssignDriver,
    this.onRedispatch,
    this.onCancelOverride,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<VaayuColors>() ?? VaayuColors.dark;

    if (alerts.isEmpty) {
      return VaayuCard(
        key: const Key('operations_nominal_card'),
        padding: const EdgeInsets.all(VaayuSpacing.md),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: colors.success.withValues(alpha: 0.15),
                shape: BoxShape.circle,
              ),
              child: Icon(Icons.check_circle_outline, color: colors.success, size: 24),
            ),
            const SizedBox(width: VaayuSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'ALL FLEET SYSTEMS NOMINAL',
                    style: TextStyle(
                      color: colors.success,
                      fontWeight: FontWeight.bold,
                      fontSize: 13,
                      letterSpacing: 0.8,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'Zero dispatch bottlenecks or telemetry drops detected.',
                    style: TextStyle(
                      color: colors.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            const StatusBadge(
              label: '100% HEALTHY',
              type: StatusBadgeType.online,
            ),
          ],
        ),
      );
    }

    final criticalCount = alerts.where((a) => a.severity == AlertSeverity.critical || a.severity == AlertSeverity.high).length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Exception-First Header
        Container(
          padding: const EdgeInsets.symmetric(horizontal: VaayuSpacing.sm, vertical: 6),
          decoration: BoxDecoration(
            color: colors.danger.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(VaayuRadius.sm),
            border: Border.all(color: colors.danger.withValues(alpha: 0.3)),
          ),
          child: Row(
            children: [
              Icon(Icons.warning_amber_rounded, color: colors.danger, size: 18),
              const SizedBox(width: 8),
              Text(
                'ATTENTION REQUIRED (${alerts.length})',
                style: TextStyle(
                  color: colors.danger,
                  fontWeight: FontWeight.bold,
                  fontSize: 13,
                  letterSpacing: 0.8,
                ),
              ),
              const Spacer(),
              if (criticalCount > 0)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: colors.danger,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    '$criticalCount CRITICAL',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: VaayuSpacing.xs),

        // Incident Cards
        ...alerts.map((alert) => Padding(
          padding: const EdgeInsets.only(bottom: VaayuSpacing.xs),
          child: OperationsIncidentCard(
            key: Key('incident_card_${alert.id}'),
            alert: alert,
            onAssignDriver: onAssignDriver,
            onRedispatch: onRedispatch,
            onCancelOverride: onCancelOverride,
          ),
        )),
      ],
    );
  }
}

class OperationsIncidentCard extends StatelessWidget {
  final OperationalAlert alert;
  final void Function(String orderId)? onAssignDriver;
  final void Function(String orderId)? onRedispatch;
  final void Function(String orderId)? onCancelOverride;

  const OperationsIncidentCard({
    super.key,
    required this.alert,
    this.onAssignDriver,
    this.onRedispatch,
    this.onCancelOverride,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<VaayuColors>() ?? VaayuColors.dark;

    final isCritical = alert.severity == AlertSeverity.critical || alert.severity == AlertSeverity.high;
    final sevColor = isCritical ? colors.danger : colors.warning;
    final sevText = alert.severity.name.toUpperCase();

    return VaayuCard(
      borderColor: isCritical ? colors.danger.withValues(alpha: 0.6) : colors.border,
      backgroundColor: isCritical ? colors.danger.withValues(alpha: 0.06) : colors.surfaceElevated,
      padding: const EdgeInsets.all(VaayuSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: sevColor.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(4),
                  border: Border.all(color: sevColor),
                ),
                child: Text(
                  sevText,
                  style: TextStyle(
                    color: sevColor,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                _alertTypeLabel(alert.type),
                style: TextStyle(
                  color: colors.textPrimary,
                  fontWeight: FontWeight.w600,
                  fontSize: 12,
                ),
              ),
              const Spacer(),
              Text(
                '${alert.ageSec}s ago',
                style: TextStyle(
                  color: colors.textTertiary,
                  fontSize: 11,
                  fontFamily: 'monospace',
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            alert.message,
            style: TextStyle(
              color: colors.textSecondary,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 8),

          // Context entity metadata
          Row(
            children: [
              if (alert.orderId != null) ...[
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: colors.border.withValues(alpha: 0.3),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    'Order: ${alert.orderId}',
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontSize: 10,
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
                const SizedBox(width: 6),
              ],
              if (alert.driverName != null) ...[
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: colors.border.withValues(alpha: 0.3),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    'Driver: ${alert.driverName}',
                    style: TextStyle(
                      color: colors.textSecondary,
                      fontSize: 10,
                    ),
                  ),
                ),
              ],
            ],
          ),

          // Operator Intervention CTA Bar
          if (alert.orderId != null) ...[
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                if (onCancelOverride != null) ...[
                  VaayuButton(
                    key: Key('btn_cancel_${alert.id}'),
                    label: 'Cancel Trip',
                    isFullWidth: false,
                    variant: VaayuButtonVariant.danger,
                    onPressed: () => onCancelOverride!(alert.orderId!),
                  ),
                  const SizedBox(width: 6),
                ],
                if (onAssignDriver != null) ...[
                  VaayuButton(
                    key: Key('btn_assign_${alert.id}'),
                    label: 'Manual Assign',
                    isFullWidth: false,
                    variant: VaayuButtonVariant.secondary,
                    onPressed: () => onAssignDriver!(alert.orderId!),
                  ),
                  const SizedBox(width: 6),
                ],
                if (onRedispatch != null) ...[
                  VaayuButton(
                    key: Key('btn_redispatch_${alert.id}'),
                    label: 'Re-Dispatch',
                    isFullWidth: false,
                    variant: VaayuButtonVariant.primary,
                    onPressed: () => onRedispatch!(alert.orderId!),
                  ),
                ],
              ],
            ),
          ],
        ],
      ),
    );
  }

  String _alertTypeLabel(AlertType type) {
    switch (type) {
      case AlertType.dispatchTimeoutDelay:
        return 'DISPATCH TIMEOUT';
      case AlertType.telemetrySignalLoss:
        return 'SIGNAL DROP';
      case AlertType.tripSlaBreach:
        return 'SLA AT RISK';
      case AlertType.offerRejected:
        return 'OFFER REJECTED';
      case AlertType.geofenceException:
        return 'GEOFENCE MISMATCH';
      case AlertType.unspecified:
        return 'INCIDENT';
    }
  }
}
