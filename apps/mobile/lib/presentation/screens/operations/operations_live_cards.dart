/// E4.3: Live Fleet & Active Trip Cards for VAAYU Operations Cockpit.
/// Displays individual driver telemetry states and active trip progress with ETA.
library operations_live_cards;

import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_colors.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../../domain/operations/operations_models.dart';
import '../../common/widgets/status_badge.dart';
import '../../common/widgets/vaayu_card.dart';

class OperationsDriverCard extends StatelessWidget {
  final FleetDriverLive driver;
  final VoidCallback? onTap;

  const OperationsDriverCard({
    super.key,
    required this.driver,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<VaayuColors>() ?? VaayuColors.dark;

    StatusBadgeType badgeType;
    switch (driver.livenessState.toUpperCase()) {
      case 'ONLINE':
        badgeType = StatusBadgeType.online;
        break;
      case 'DEGRADED':
      case 'STALE':
        badgeType = StatusBadgeType.warning;
        break;
      default:
        badgeType = StatusBadgeType.offline;
    }

    return VaayuCard(
      onTap: onTap,
      padding: const EdgeInsets.all(VaayuSpacing.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  driver.name,
                  style: TextStyle(
                    color: colors.textPrimary,
                    fontWeight: FontWeight.bold,
                    fontSize: 13,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              StatusBadge(
                label: driver.livenessState,
                type: badgeType,
              ),
            ],
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              if (driver.vehicleNumber != null) ...[
                Text(
                  driver.vehicleNumber!,
                  style: TextStyle(
                    color: colors.secondary,
                    fontFamily: 'monospace',
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(width: 8),
              ],
              Text(
                '★ ${driver.rating.toStringAsFixed(1)}',
                style: TextStyle(
                  color: colors.warning,
                  fontSize: 11,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const Spacer(),
              if (driver.pingAgeSec != null)
                Text(
                  '${driver.pingAgeSec}s ago',
                  style: TextStyle(
                    color: colors.textTertiary,
                    fontSize: 10,
                    fontFamily: 'monospace',
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              if (driver.isReserved) ...[
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: colors.primary.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: colors.primary.withValues(alpha: 0.4)),
                  ),
                  child: Text(
                    'RESERVED: ${driver.reservedOrderId ?? "ACTIVE"}',
                    style: TextStyle(
                      color: colors.primary,
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
              ] else ...[
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: colors.border.withValues(alpha: 0.25),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    'DUTY: ${driver.dutyStatus}',
                    style: TextStyle(
                      color: colors.textSecondary,
                      fontSize: 10,
                    ),
                  ),
                ),
              ],
              const Spacer(),
              if (driver.speed != null)
                Text(
                  '${driver.speed!.toStringAsFixed(0)} km/h',
                  style: TextStyle(
                    color: colors.textSecondary,
                    fontSize: 10,
                    fontFamily: 'monospace',
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class OperationsTripCard extends StatelessWidget {
  final ActiveTripSummary trip;
  final void Function(String orderId)? onIntervene;

  const OperationsTripCard({
    super.key,
    required this.trip,
    this.onIntervene,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<VaayuColors>() ?? VaayuColors.dark;

    StatusBadgeType badgeType;
    switch (trip.status) {
      case 'CREATED':
      case 'SEARCHING_DRIVER':
        badgeType = StatusBadgeType.warning;
        break;
      case 'DRIVER_ASSIGNED':
      case 'DRIVER_ACCEPTED':
      case 'DRIVER_ARRIVING':
        badgeType = StatusBadgeType.connecting;
        break;
      case 'IN_TRANSIT':
        badgeType = StatusBadgeType.syncing;
        break;
      case 'DELIVERED':
        badgeType = StatusBadgeType.online;
        break;
      case 'CANCELLED':
        badgeType = StatusBadgeType.danger;
        break;
      default:
        badgeType = StatusBadgeType.neutral;
    }

    return VaayuCard(
      padding: const EdgeInsets.all(VaayuSpacing.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                trip.id,
                style: TextStyle(
                  color: colors.textPrimary,
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.bold,
                  fontSize: 12,
                ),
              ),
              const Spacer(),
              StatusBadge(
                label: trip.status,
                type: badgeType,
              ),
            ],
          ),
          const SizedBox(height: 6),

          // Route info
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Column(
                children: [
                  Icon(Icons.trip_origin_rounded, size: 12, color: colors.primary),
                  Container(width: 1.5, height: 16, color: colors.border),
                  Icon(Icons.location_on_rounded, size: 12, color: colors.secondary),
                ],
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      trip.pickupAddress,
                      style: TextStyle(color: colors.textSecondary, fontSize: 11),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 6),
                    Text(
                      trip.dropoffAddress,
                      style: TextStyle(color: colors.textPrimary, fontSize: 11, fontWeight: FontWeight.w500),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    '₹${trip.totalFare.toStringAsFixed(0)}',
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontWeight: FontWeight.bold,
                      fontSize: 13,
                    ),
                  ),
                  if (trip.liveEta != null)
                    Text(
                      trip.liveEta!,
                      style: TextStyle(
                        color: colors.secondary,
                        fontSize: 10,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 6),

          // Footer meta
          Row(
            children: [
              if (trip.driverName != null) ...[
                Icon(Icons.person_pin_circle_outlined, size: 12, color: colors.textTertiary),
                const SizedBox(width: 4),
                Text(
                  trip.driverName!,
                  style: TextStyle(color: colors.textSecondary, fontSize: 10),
                ),
                const SizedBox(width: 8),
              ],
              Text(
                'Elapsed: ${trip.waitingTimeSec}s',
                style: TextStyle(color: colors.textTertiary, fontSize: 10, fontFamily: 'monospace'),
              ),
              const Spacer(),
              if (onIntervene != null)
                GestureDetector(
                  key: Key('btn_trip_intervene_${trip.id}'),
                  onTap: () => onIntervene!(trip.id),
                  child: Text(
                    'MANAGE',
                    style: TextStyle(
                      color: colors.secondary,
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 0.5,
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
