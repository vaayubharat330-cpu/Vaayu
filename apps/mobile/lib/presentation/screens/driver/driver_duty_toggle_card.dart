import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../../domain/driver/driver_models.dart';
import '../../common/widgets/metric_chip.dart';
import '../../common/widgets/status_badge.dart';
import '../../common/widgets/vaayu_button.dart';
import '../../common/widgets/vaayu_card.dart';

/// Driver Partner Duty Mode & Telemetry Status Card.
///
/// Features:
/// - Online/Offline Duty mode toggle bound to authoritative backend status.
/// - Live telemetry broadcasting pulse indicator.
/// - Daily driver partner performance metrics (earnings, completed trips, rating).
class DriverDutyToggleCard extends StatelessWidget {
  final DriverProfile? profile;
  final bool isOnline;
  final bool isLoading;
  final bool isPublishingGps;
  final int? gpsSequence;
  final ValueChanged<bool> onToggleDuty;

  const DriverDutyToggleCard({
    super.key,
    this.profile,
    required this.isOnline,
    this.isLoading = false,
    this.isPublishingGps = false,
    this.gpsSequence,
    required this.onToggleDuty,
  });

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);

    final name = profile?.name.isNotEmpty == true ? profile!.name : 'Partner Driver';
    final rating = profile?.rating ?? 5.0;
    final todayEarnings = profile?.todayEarnings ?? 0.0;
    final todayTrips = profile?.todayTrips ?? 0;
    final vehiclePlate = profile?.vehiclePlate ?? 'KA 01 EQ 4421';

    return VaayuCard(
      elevation: VaayuElevation.medium,
      backgroundColor: colors.surfaceElevated,
      borderColor: isOnline ? colors.primary.withValues(alpha: 0.3) : colors.border,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 1. Driver Profile Header & Status
          Row(
            children: [
              Container(
                width: 52,
                height: 52,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: isOnline ? colors.primary.withValues(alpha: 0.15) : colors.surface,
                  border: Border.all(
                    color: isOnline ? colors.primary : colors.border,
                    width: 2,
                  ),
                ),
                child: Center(
                  child: Icon(
                    Icons.two_wheeler,
                    color: isOnline ? colors.primary : colors.textSecondary,
                    size: 28,
                  ),
                ),
              ),
              const SizedBox(width: VaayuSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w800,
                        color: colors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Row(
                      children: [
                        MetricChip(
                          icon: Icons.star,
                          value: rating.toStringAsFixed(1),
                          accentColor: colors.warning,
                        ),
                        const SizedBox(width: VaayuSpacing.xs),
                        Text(
                          vehiclePlate,
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: colors.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              StatusBadge(
                label: isOnline ? 'ONLINE' : 'OFFLINE',
                type: isOnline ? StatusBadgeType.online : StatusBadgeType.neutral,
              ),
            ],
          ),

          const SizedBox(height: VaayuSpacing.md),
          const Divider(),
          const SizedBox(height: VaayuSpacing.sm),

          // 2. Performance Summary Chips
          Row(
            children: [
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: VaayuSpacing.sm,
                    vertical: VaayuSpacing.sm,
                  ),
                  decoration: BoxDecoration(
                    color: colors.surface,
                    borderRadius: VaayuRadius.mdBorder,
                    border: Border.all(color: colors.border),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'TODAY EARNINGS',
                        style: TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.5,
                          color: colors.textTertiary,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '₹${todayEarnings.toStringAsFixed(2)}',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                          color: colors.primary,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: VaayuSpacing.sm),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: VaayuSpacing.sm,
                    vertical: VaayuSpacing.sm,
                  ),
                  decoration: BoxDecoration(
                    color: colors.surface,
                    borderRadius: VaayuRadius.mdBorder,
                    border: Border.all(color: colors.border),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'COMPLETED TRIPS',
                        style: TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.5,
                          color: colors.textTertiary,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '$todayTrips Trips',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                          color: colors.textPrimary,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),

          const SizedBox(height: VaayuSpacing.md),

          // 3. Telemetry Stream Indicator
          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: VaayuSpacing.md,
              vertical: VaayuSpacing.sm,
            ),
            decoration: BoxDecoration(
              color: isOnline
                  ? colors.secondary.withValues(alpha: 0.08)
                  : colors.surface,
              borderRadius: VaayuRadius.mdBorder,
              border: Border.all(
                color: isOnline
                    ? colors.secondary.withValues(alpha: 0.25)
                    : colors.border,
              ),
            ),
            child: Row(
              children: [
                Icon(
                  Icons.satellite_alt,
                  color: isOnline ? colors.secondary : colors.textTertiary,
                  size: 18,
                ),
                const SizedBox(width: VaayuSpacing.sm),
                Expanded(
                  child: Text(
                    isOnline
                        ? (gpsSequence != null
                            ? 'GPS Broadcasting active (#$gpsSequence)'
                            : 'GPS Ready & Broadcasting telemetry')
                        : 'Telemetry Idle — Go online to receive rides',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: isOnline ? colors.textPrimary : colors.textSecondary,
                    ),
                  ),
                ),
                if (isOnline)
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: colors.secondary,
                    ),
                  ),
              ],
            ),
          ),

          const SizedBox(height: VaayuSpacing.md),

          // 4. Primary Duty Mode Switch Button
          VaayuButton(
            key: const Key('btn_duty_toggle'),
            label: isOnline ? 'GO OFFLINE' : 'GO ONLINE — START DUTY',
            variant: isOnline ? VaayuButtonVariant.outlined : VaayuButtonVariant.primary,
            leadingIcon: isOnline ? Icons.power_settings_new : Icons.flash_on,
            isLoading: isLoading,
            onPressed: () => onToggleDuty(!isOnline),
          ),
        ],
      ),
    );
  }
}
