/// Live Fleet & Active Trip Cards for VAAYU Operations Cockpit.
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
  const OperationsDriverCard({super.key, required this.driver, this.onTap});
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<VaayuColors>() ?? VaayuColors.dark;
    final badgeType = switch (driver.livenessState.toUpperCase()) { 'ONLINE' => StatusBadgeType.online, 'DEGRADED' || 'STALE' => StatusBadgeType.warning, _ => StatusBadgeType.offline };
    return VaayuCard(onTap: onTap, padding: const EdgeInsets.all(VaayuSpacing.sm), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [Expanded(child: Text(driver.name, style: TextStyle(color: colors.textPrimary, fontWeight: FontWeight.bold, fontSize: 13), overflow: TextOverflow.ellipsis)), StatusBadge(label: driver.livenessState, type: badgeType)]),
      const SizedBox(height: 4),
      Row(children: [if (driver.vehicleNumber != null) ...[Text(driver.vehicleNumber!, style: TextStyle(color: colors.secondary, fontFamily: 'monospace', fontSize: 11, fontWeight: FontWeight.w600)), const SizedBox(width: 8)], Text('★ ${driver.rating.toStringAsFixed(1)}', style: TextStyle(color: colors.warning, fontSize: 11, fontWeight: FontWeight.bold)), const Spacer(), if (driver.pingAgeSec != null) Text('${driver.pingAgeSec}s ago', style: TextStyle(color: colors.textTertiary, fontSize: 10, fontFamily: 'monospace'))]),
      const SizedBox(height: 6),
      Row(children: [Container(padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2), decoration: BoxDecoration(color: colors.border.withValues(alpha: 0.25), borderRadius: BorderRadius.circular(4)), child: Text(driver.isReserved ? 'RESERVED: ${driver.reservedOrderId ?? "ACTIVE"}' : 'DUTY: ${driver.dutyStatus}', style: TextStyle(color: driver.isReserved ? colors.primary : colors.textSecondary, fontSize: 10, fontWeight: driver.isReserved ? FontWeight.bold : FontWeight.normal))), const Spacer(), if (driver.speed != null) Text('${driver.speed!.toStringAsFixed(0)} km/h', style: TextStyle(color: colors.textSecondary, fontSize: 10, fontFamily: 'monospace'))]),
    ]));
  }
}

class OperationsTripCard extends StatelessWidget {
  final ActiveTripSummary trip;
  final void Function(String orderId)? onIntervene;
  final void Function(String tripId)? onLiveCamera;
  const OperationsTripCard({super.key, required this.trip, this.onIntervene, this.onLiveCamera});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<VaayuColors>() ?? VaayuColors.dark;
    final badgeType = switch (trip.status) { 'CREATED' || 'SEARCHING_DRIVER' => StatusBadgeType.warning, 'DRIVER_ASSIGNED' || 'DRIVER_ACCEPTED' || 'DRIVER_ARRIVING' => StatusBadgeType.connecting, 'IN_TRANSIT' => StatusBadgeType.syncing, 'DELIVERED' => StatusBadgeType.online, 'CANCELLED' => StatusBadgeType.danger, _ => StatusBadgeType.neutral };
    return VaayuCard(padding: const EdgeInsets.all(VaayuSpacing.sm), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [Text(trip.id, style: TextStyle(color: colors.textPrimary, fontFamily: 'monospace', fontWeight: FontWeight.bold, fontSize: 12)), const Spacer(), StatusBadge(label: trip.status, type: badgeType)]),
      const SizedBox(height: 6),
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Column(children: [Icon(Icons.trip_origin_rounded, size: 12, color: colors.primary), Container(width: 1.5, height: 16, color: colors.border), Icon(Icons.location_on_rounded, size: 12, color: colors.secondary)]), const SizedBox(width: 8), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(trip.pickupAddress, style: TextStyle(color: colors.textSecondary, fontSize: 11), maxLines: 1, overflow: TextOverflow.ellipsis), const SizedBox(height: 6), Text(trip.dropoffAddress, style: TextStyle(color: colors.textPrimary, fontSize: 11, fontWeight: FontWeight.w500), maxLines: 1, overflow: TextOverflow.ellipsis)])), Column(crossAxisAlignment: CrossAxisAlignment.end, children: [Text('₹${trip.totalFare.toStringAsFixed(0)}', style: TextStyle(color: colors.textPrimary, fontWeight: FontWeight.bold, fontSize: 13)), if (trip.liveEta != null) Text(trip.liveEta!, style: TextStyle(color: colors.secondary, fontSize: 10, fontWeight: FontWeight.w600))])]),
      const SizedBox(height: 6),
      Row(children: [if (trip.driverName != null) ...[Icon(Icons.person_pin_circle_outlined, size: 12, color: colors.textTertiary), const SizedBox(width: 4), Text(trip.driverName!, style: TextStyle(color: colors.textSecondary, fontSize: 10)), const SizedBox(width: 8)], Text('Elapsed: ${trip.waitingTimeSec}s', style: TextStyle(color: colors.textTertiary, fontSize: 10, fontFamily: 'monospace')), const Spacer(), if (onLiveCamera != null && trip.status != 'DELIVERED' && trip.status != 'CANCELLED') IconButton(key: Key('btn_trip_camera_${trip.id}'), tooltip: 'Live camera', icon: Icon(Icons.videocam_outlined, color: colors.primary, size: 18), padding: EdgeInsets.zero, constraints: const BoxConstraints(minWidth: 32, minHeight: 32), onPressed: () => onLiveCamera!(trip.id)), if (onIntervene != null) GestureDetector(key: Key('btn_trip_intervene_${trip.id}'), onTap: () => onIntervene!(trip.id), child: Text('MANAGE', style: TextStyle(color: colors.secondary, fontSize: 11, fontWeight: FontWeight.bold, letterSpacing: 0.5)))])
    ]));
  }
}
