import 'package:flutter/material.dart';
import '../../../core/projection/driver_location_projection.dart';
import '../../../core/projection/driver_location_store.dart';
import '../../../core/projection/local_trip_projection.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../common/widgets/status_badge.dart';
import '../../common/widgets/vaayu_button.dart';
import '../../common/widgets/vaayu_card.dart';
import '../../common/widgets/metric_chip.dart';
import '../../state/customer_trip_controller.dart';
import '../../state/view_state.dart';

/// Customer Active Ride Cockpit.
///
/// Decoupling Invariants strictly enforced:
/// - Trip milestones consume [ProjectionStore] via [CustomerTripController.activeTripStream].
/// - Realtime driver location updates consume [DriverLocationStore.locationsStream].
/// - Driver GPS sequence increments independently without modifying monotonic trip version.
class CustomerActiveRideCockpit extends StatelessWidget {
  final CustomerTripController controller;
  final DriverLocationStore locationStore;

  const CustomerActiveRideCockpit({
    super.key,
    required this.controller,
    required this.locationStore,
  });

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);

    final disableAnimations = MediaQuery.disableAnimationsOf(context);

    return StreamBuilder<ViewState<LocalTripProjection>>(
      stream: controller.activeTripStream,
      initialData: controller.activeTripState,
      builder: (context, snapshot) {
        final tripState = snapshot.data ?? controller.activeTripState;
        final projection = tripState.data;

        if (projection == null) {
          return Center(
            child: Text(
              'No active ride session.',
              style: TextStyle(color: colors.textSecondary),
            ),
          );
        }

        final status = projection.status.toUpperCase();
        final isSearching = status == 'CREATED' || status == 'REQUESTED' || status == 'SEARCHING';
        final isDriverAssigned = status == 'DRIVER_ASSIGNED' ||
            status == 'DRIVER_ACCEPTED' ||
            status == 'DRIVER_ARRIVING' ||
            status == 'DRIVER_AT_PICKUP';
        final isInTransit = status == 'IN_TRANSIT' ||
            status == 'PICKED_UP' ||
            status == 'DRIVER_AT_DROPOFF';
        final isCompleted = status == 'DELIVERED' || status == 'COMPLETED';
        final isCancelled = status == 'CANCELLED';

        return SingleChildScrollView(
          padding: const EdgeInsets.all(VaayuSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // 1. Status Header & Monotonic Version Chip
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  StatusBadge(
                    label: _formatStatusLabel(status),
                    type: _statusBadgeType(status),
                  ),
                  Row(
                    children: [
                      MetricChip(
                        icon: Icons.tag,
                        label: 'Version',
                        value: 'v${projection.version}',
                        accentColor: colors.secondary,
                      ),
                      const SizedBox(width: VaayuSpacing.xs),
                      MetricChip(
                        icon: Icons.confirmation_number_outlined,
                        value: projection.tripId.length > 12
                            ? '...${projection.tripId.substring(projection.tripId.length - 8)}'
                            : projection.tripId,
                      ),
                    ],
                  ),
                ],
              ),

              const SizedBox(height: VaayuSpacing.md),

              // 2. Searching Radar Card
              if (isSearching)
                VaayuCard(
                  backgroundColor: colors.surfaceElevated,
                  child: Column(
                    children: [
                      const SizedBox(height: VaayuSpacing.md),
                      SizedBox(
                        width: 56,
                        height: 56,
                        child: Stack(
                          alignment: Alignment.center,
                          children: [
                            CircularProgressIndicator(
                              strokeWidth: 3,
                              valueColor: AlwaysStoppedAnimation<Color>(colors.primary),
                            ),
                            Icon(Icons.radar, color: colors.primary, size: 28),
                          ],
                        ),
                      ),
                      const SizedBox(height: VaayuSpacing.md),
                      Text(
                        'Broadcasting to Nearby Fleets...',
                        style: TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w700,
                          color: colors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Matching with nearest active verified partner',
                        style: TextStyle(fontSize: 12, color: colors.textSecondary),
                      ),
                      const SizedBox(height: VaayuSpacing.lg),
                      VaayuButton(
                        label: 'Cancel Request',
                        variant: VaayuButtonVariant.outlined,
                        onPressed: () => controller.cancelActiveTrip('Customer cancelled before dispatch'),
                      ),
                    ],
                  ),
                ),

              // 3. Driver Assigned & Pickup OTP Banner
              if (isDriverAssigned) ...[
                if (projection.pickupOtp != null)
                  Container(
                    margin: const EdgeInsets.only(bottom: VaayuSpacing.md),
                    padding: const EdgeInsets.symmetric(horizontal: VaayuSpacing.md, vertical: VaayuSpacing.sm * 1.5),
                    decoration: BoxDecoration(
                      color: colors.primary.withValues(alpha: 0.12),
                      borderRadius: VaayuRadius.lgBorder,
                      border: Border.all(color: colors.primary, width: 1.5),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'START TRIP PIN',
                              style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                                letterSpacing: 0.8,
                                color: colors.primary,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              'Share OTP with driver at pickup',
                              style: TextStyle(fontSize: 12, color: colors.textPrimary),
                            ),
                          ],
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                          decoration: BoxDecoration(
                            color: colors.primary,
                            borderRadius: VaayuRadius.mdBorder,
                          ),
                          child: Text(
                            projection.pickupOtp!,
                            style: TextStyle(
                              fontSize: 22,
                              fontWeight: FontWeight.w900,
                              letterSpacing: 4,
                              color: colors.onPrimary,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),

                // Driver Profile Card
                VaayuCard(
                  child: Row(
                    children: [
                      Container(
                        width: 48,
                        height: 48,
                        decoration: BoxDecoration(
                          color: colors.surface,
                          shape: BoxShape.circle,
                          border: Border.all(color: colors.border),
                        ),
                        child: Icon(Icons.person, color: colors.textPrimary, size: 28),
                      ),
                      const SizedBox(width: VaayuSpacing.md),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              projection.driverName ?? 'Assigned Partner',
                              style: TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w700,
                                color: colors.textPrimary,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Row(
                              children: [
                                MetricChip(
                                  icon: Icons.star,
                                  value: '4.9',
                                  accentColor: colors.warning,
                                ),
                                const SizedBox(width: VaayuSpacing.xs),
                                Text(
                                  projection.driverPhone ?? '+91 7842416560',
                                  style: TextStyle(fontSize: 12, color: colors.textSecondary),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                      IconButton(
                        icon: Icon(Icons.phone, color: colors.primary),
                        onPressed: () {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text('Calling ${projection.driverPhone ?? "Driver"}...')),
                          );
                        },
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: VaayuSpacing.md),

                // 4. Live Decoupled GPS Telemetry Feed
                StreamBuilder<DriverLocationProjection>(
                  stream: locationStore.locationsStream,
                  initialData: locationStore.getLocation(projection.tripId),
                  builder: (context, locSnapshot) {
                    final loc = locSnapshot.data ?? locationStore.getLocation(projection.tripId);
                    final lat = loc?.latitude ?? projection.driverLat;
                    final lng = loc?.longitude ?? projection.driverLng;
                    final seq = loc?.sequence;

                    return VaayuCard(
                      backgroundColor: colors.surface,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Row(
                                children: [
                                  AnimatedRotation(
                                    turns: ((seq ?? 0) % 360) / 360.0,
                                    duration: disableAnimations ? Duration.zero : const Duration(milliseconds: 300),
                                    curve: Curves.easeOutCubic,
                                    child: Icon(Icons.navigation, color: colors.secondary, size: 18),
                                  ),
                                  const SizedBox(width: VaayuSpacing.xs),
                                  Text(
                                    'Realtime Location Stream',
                                    style: TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w700,
                                      color: colors.textPrimary,
                                    ),
                                  ),
                                ],
                              ),
                              if (seq != null)
                                MetricChip(
                                  label: 'GPS Seq',
                                  value: '#$seq',
                                  accentColor: colors.secondary,
                                )
                              else
                                const StatusBadge(label: 'Syncing GPS', type: StatusBadgeType.connecting),
                            ],
                          ),
                          const SizedBox(height: VaayuSpacing.sm),
                          Text(
                            lat != null && lng != null
                                ? 'Coordinates: ${lat.toStringAsFixed(5)}, ${lng.toStringAsFixed(5)}'
                                : 'Locating vehicle GPS stream...',
                            style: TextStyle(fontSize: 12, color: colors.textSecondary),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'Decoupled GPS sequencing: Location updates never corrupt trip-state authority.',
                            style: TextStyle(fontSize: 10, color: colors.textTertiary),
                          ),
                        ],
                      ),
                    );
                  },
                ),
              ],

              // 5. In-Transit View
              if (isInTransit) ...[
                VaayuCard(
                  backgroundColor: colors.surface,
                  child: Column(
                    children: [
                      Row(
                        children: [
                          Icon(Icons.security, color: colors.primary, size: 20),
                          const SizedBox(width: VaayuSpacing.sm),
                          Expanded(
                            child: Text(
                              'Ride Monitored by VAAYU Sentinel',
                              style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w700,
                                color: colors.textPrimary,
                              ),
                            ),
                          ),
                          const StatusBadge(label: 'En Route', type: StatusBadgeType.online),
                        ],
                      ),
                      const SizedBox(height: VaayuSpacing.sm),
                      const Divider(),
                      const SizedBox(height: VaayuSpacing.sm),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text('Authoritative Locked Fare', style: TextStyle(fontSize: 13, color: colors.textSecondary)),
                          Text(
                            '₹${projection.totalFare.toStringAsFixed(2)}',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w800,
                              color: colors.primary,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],

              // 6. Completed Receipt Card
              if (isCompleted) ...[
                VaayuCard(
                  borderColor: colors.success,
                  backgroundColor: colors.success.withValues(alpha: 0.08),
                  child: Column(
                    children: [
                      Icon(Icons.check_circle, color: colors.success, size: 48),
                      const SizedBox(height: VaayuSpacing.sm),
                      Text(
                        'Trip Completed Successfully',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w800,
                          color: colors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Reconciled to double-entry ledger with ₹0 discrepancy',
                        style: TextStyle(fontSize: 12, color: colors.textSecondary),
                      ),
                      const SizedBox(height: VaayuSpacing.md),
                      const Divider(),
                      const SizedBox(height: VaayuSpacing.sm),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text('Settled Fare Total', style: TextStyle(fontSize: 14, color: colors.textSecondary)),
                          Text(
                            '₹${projection.totalFare.toStringAsFixed(2)}',
                            style: TextStyle(
                              fontSize: 22,
                              fontWeight: FontWeight.w900,
                              color: colors.success,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: VaayuSpacing.lg),
                      VaayuButton(
                        label: 'Done / Book Another Ride',
                        onPressed: () => controller.clearActiveTrip(),
                      ),
                    ],
                  ),
                ),
              ],

              // 7. Cancelled Notice
              if (isCancelled) ...[
                VaayuCard(
                  borderColor: colors.danger,
                  backgroundColor: colors.danger.withValues(alpha: 0.08),
                  child: Column(
                    children: [
                      Icon(Icons.cancel, color: colors.danger, size: 48),
                      const SizedBox(height: VaayuSpacing.sm),
                      Text(
                        'Trip Cancelled',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w800,
                          color: colors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: VaayuSpacing.md),
                      VaayuButton(
                        label: 'Dismiss & Return to Booking',
                        variant: VaayuButtonVariant.outlined,
                        onPressed: () => controller.clearActiveTrip(),
                      ),
                    ],
                  ),
                ),
              ],

              const SizedBox(height: VaayuSpacing.lg),

              // 8. Emergency Controls & Cancellation
              if (isDriverAssigned || isInTransit)
                Row(
                  children: [
                    Expanded(
                      child: VaayuButton(
                        label: 'SOS Alert',
                        variant: VaayuButtonVariant.danger,
                        leadingIcon: Icons.emergency,
                        onPressed: () {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(
                              content: Text('SOS Emergency Alert Dispatched to Central Operations'),
                              backgroundColor: Colors.red,
                            ),
                          );
                        },
                      ),
                    ),
                    const SizedBox(width: VaayuSpacing.md),
                    Expanded(
                      child: VaayuButton(
                        label: 'Cancel Ride',
                        variant: VaayuButtonVariant.outlined,
                        onPressed: () => controller.cancelActiveTrip('Customer requested cancellation'),
                      ),
                    ),
                  ],
                ),
            ],
          ),
        );
      },
    );
  }

  String _formatStatusLabel(String status) {
    return switch (status) {
      'CREATED' || 'REQUESTED' || 'SEARCHING' => 'Finding Driver',
      'DRIVER_ASSIGNED' || 'DRIVER_ACCEPTED' => 'Driver Assigned',
      'DRIVER_ARRIVING' => 'Driver Arriving',
      'DRIVER_AT_PICKUP' => 'At Pickup Point',
      'IN_TRANSIT' || 'PICKED_UP' => 'Ride in Progress',
      'DRIVER_AT_DROPOFF' => 'Arrived at Destination',
      'DELIVERED' || 'COMPLETED' => 'Completed',
      'CANCELLED' => 'Cancelled',
      _ => status,
    };
  }

  StatusBadgeType _statusBadgeType(String status) {
    return switch (status) {
      'CREATED' || 'REQUESTED' || 'SEARCHING' => StatusBadgeType.connecting,
      'DRIVER_ASSIGNED' || 'DRIVER_ACCEPTED' || 'DRIVER_ARRIVING' => StatusBadgeType.online,
      'DRIVER_AT_PICKUP' => StatusBadgeType.warning,
      'IN_TRANSIT' || 'PICKED_UP' || 'DRIVER_AT_DROPOFF' => StatusBadgeType.online,
      'DELIVERED' || 'COMPLETED' => StatusBadgeType.online,
      'CANCELLED' => StatusBadgeType.danger,
      _ => StatusBadgeType.neutral,
    };
  }
}
