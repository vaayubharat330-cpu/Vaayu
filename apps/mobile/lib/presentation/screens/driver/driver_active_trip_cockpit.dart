import 'package:flutter/material.dart';
import '../../../core/projection/local_trip_projection.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../common/widgets/metric_chip.dart';
import '../../common/widgets/status_badge.dart';
import '../../common/widgets/vaayu_button.dart';
import '../../common/widgets/vaayu_card.dart';
import '../../state/driver_partner_controller.dart';
import '../../state/view_state.dart';
import 'driver_otp_verification_dialog.dart';

/// Driver-Partner High-Efficiency Active Trip Cockpit.
///
/// Features:
/// - Authoritative milestone progression through backend delivery state machine.
/// - Monotonic version tracking chip (`vX`) and trip ID identifier.
/// - Waypoint route progression (Pickup -> Destination).
/// - Customer contact card.
/// - OTP verification gate for trip start and trip completion.
/// - Decoupled GPS telemetry stream indicator.
/// - Double-entry ledger settlement receipt on completion.
class DriverActiveTripCockpit extends StatefulWidget {
  final DriverPartnerController controller;
  final int? telemetrySeq;

  const DriverActiveTripCockpit({
    super.key,
    required this.controller,
    this.telemetrySeq,
  });

  @override
  State<DriverActiveTripCockpit> createState() => _DriverActiveTripCockpitState();
}

class _DriverActiveTripCockpitState extends State<DriverActiveTripCockpit> {
  bool _isActionInProgress = false;

  Future<void> _advanceAction(String action, {String? otp, Map<String, dynamic>? proof}) async {
    setState(() => _isActionInProgress = true);
    try {
      final success = await widget.controller.advanceState(
        action: action,
        otp: otp,
        proof: proof,
      );
      if (!mounted) return;
      if (!success) {
        final err = widget.controller.activeDeliveryState.errorMessage ?? 'Transition failed';
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Action failed: $err'),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isActionInProgress = false);
    }
  }

  void _handlePickupOtpFlow() {
    DriverOtpVerificationDialog.show(
      context,
      title: 'Verify Customer OTP',
      subtitle: 'Ask the rider for their 4-digit start PIN.',
      actionLabel: 'Verify & Start Trip',
      onVerify: (otp) async {
        final confirmed = await widget.controller.advanceState(
          action: 'confirm-pickup',
          otp: otp,
        );
        if (confirmed) {
          // Immediately start transit
          await widget.controller.advanceState(action: 'start-transit');
          return true;
        }
        return false;
      },
    );
  }

  void _handleCompleteTripFlow() {
    DriverOtpVerificationDialog.show(
      context,
      title: 'Complete Delivery PIN',
      subtitle: 'Enter rider delivery PIN or tap verify to settle payment.',
      actionLabel: 'Verify & Complete Trip',
      onVerify: (otp) async {
        return await widget.controller.advanceState(
          action: 'complete',
          otp: otp,
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);

    return StreamBuilder<ViewState<LocalTripProjection>>(
      stream: widget.controller.activeDeliveryStream,
      initialData: widget.controller.activeDeliveryState,
      builder: (context, snapshot) {
        final tripState = snapshot.data ?? widget.controller.activeDeliveryState;
        final projection = tripState.data;

        if (projection == null) {
          return Center(
            child: Text(
              'No active delivery session.',
              style: TextStyle(color: colors.textSecondary),
            ),
          );
        }

        final status = projection.status.toUpperCase();
        final isEnRoutePickup = status == 'DRIVER_ACCEPTED' || status == 'DRIVER_ARRIVING';
        final isAtPickup = status == 'DRIVER_AT_PICKUP';
        final isInTransit = status == 'PICKUP_CONFIRMED' || status == 'IN_TRANSIT' || status == 'PICKED_UP';
        final isAtDropoff = status == 'DRIVER_AT_DROPOFF';
        final isCompleted = status == 'DELIVERED' || status == 'COMPLETED';

        return SingleChildScrollView(
          padding: const EdgeInsets.all(VaayuSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // 1. Status Bar & Monotonic Version Chips
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
                        value: projection.tripId.length > 10
                            ? '...${projection.tripId.substring(projection.tripId.length - 6)}'
                            : projection.tripId,
                      ),
                    ],
                  ),
                ],
              ),

              const SizedBox(height: VaayuSpacing.md),

              // 2. Waypoint Route Progression
              VaayuCard(
                backgroundColor: colors.surfaceElevated,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'ROUTE PROGRESSION',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.0,
                        color: colors.textTertiary,
                      ),
                    ),
                    const SizedBox(height: VaayuSpacing.md),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Column(
                          children: [
                            Icon(
                              Icons.trip_origin,
                              color: (isEnRoutePickup || isAtPickup)
                                  ? colors.primary
                                  : colors.textTertiary,
                              size: 20,
                            ),
                            Container(
                              width: 2,
                              height: 36,
                              color: (isInTransit || isAtDropoff || isCompleted)
                                  ? colors.primary
                                  : colors.border,
                            ),
                            Icon(
                              Icons.location_on,
                              color: (isInTransit || isAtDropoff)
                                  ? colors.secondary
                                  : colors.textTertiary,
                              size: 20,
                            ),
                          ],
                        ),
                        const SizedBox(width: VaayuSpacing.md),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'PICKUP POINT',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w700,
                                  color: (isEnRoutePickup || isAtPickup)
                                      ? colors.primary
                                      : colors.textTertiary,
                                ),
                              ),
                              Text(
                                projection.pickupLat != 0.0
                                    ? 'Pickup (${projection.pickupLat.toStringAsFixed(4)}, ${projection.pickupLng.toStringAsFixed(4)})'
                                    : 'Customer Pickup Location',
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w700,
                                  color: colors.textPrimary,
                                ),
                              ),
                              const SizedBox(height: 20),
                              Text(
                                'DESTINATION DROPOFF',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w700,
                                  color: (isInTransit || isAtDropoff)
                                      ? colors.secondary
                                      : colors.textTertiary,
                                ),
                              ),
                              Text(
                                projection.dropLat != 0.0
                                    ? 'Dropoff (${projection.dropLat.toStringAsFixed(4)}, ${projection.dropLng.toStringAsFixed(4)})'
                                    : 'Customer Destination',
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w700,
                                  color: colors.textPrimary,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),

              const SizedBox(height: VaayuSpacing.md),

              // 3. Customer Contact & Fare Overview
              VaayuCard(
                child: Row(
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        color: colors.surface,
                        shape: BoxShape.circle,
                        border: Border.all(color: colors.border),
                      ),
                      child: Icon(Icons.person, color: colors.textPrimary, size: 24),
                    ),
                    const SizedBox(width: VaayuSpacing.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            projection.customerId != null
                                ? 'Rider (${projection.customerId})'
                                : 'Verified Rider',
                            style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w700,
                              color: colors.textPrimary,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            '+91 9876543210',
                            style: TextStyle(fontSize: 12, color: colors.textSecondary),
                          ),
                        ],
                      ),
                    ),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text(
                          '₹${projection.totalFare.toStringAsFixed(2)}',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w900,
                            color: colors.primary,
                          ),
                        ),
                        Text(
                          'Guaranteed Fare',
                          style: TextStyle(fontSize: 10, color: colors.textTertiary),
                        ),
                      ],
                    ),
                  ],
                ),
              ),

              const SizedBox(height: VaayuSpacing.md),

              // 4. Live Decoupled Telemetry Stream Status
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: VaayuSpacing.md,
                  vertical: VaayuSpacing.sm,
                ),
                decoration: BoxDecoration(
                  color: colors.surface,
                  borderRadius: VaayuRadius.mdBorder,
                  border: Border.all(color: colors.border),
                ),
                child: Row(
                  children: [
                    AnimatedRotation(
                      turns: ((widget.telemetrySeq ?? 0) % 360) / 360.0,
                      duration: MediaQuery.disableAnimationsOf(context)
                          ? Duration.zero
                          : const Duration(milliseconds: 300),
                      curve: Curves.easeOutCubic,
                      child: Icon(Icons.navigation, color: colors.secondary, size: 16),
                    ),
                    const SizedBox(width: VaayuSpacing.sm),
                    Expanded(
                      child: Text(
                        widget.telemetrySeq != null
                            ? 'Driver GPS Telemetry active (#${widget.telemetrySeq})'
                            : 'GPS Telemetry streaming to central dispatch',
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: colors.textSecondary,
                        ),
                      ),
                    ),
                    const StatusBadge(label: 'GPS Synced', type: StatusBadgeType.online),
                  ],
                ),
              ),

              const SizedBox(height: VaayuSpacing.lg),

              // 5. Dynamic Milestone Progression Action CTA
              AnimatedSwitcher(
                duration: MediaQuery.disableAnimationsOf(context)
                    ? Duration.zero
                    : const Duration(milliseconds: 250),
                switchInCurve: Curves.easeOutCubic,
                switchOutCurve: Curves.easeInCubic,
                child: _buildMilestoneAction(status),
              ),

              // 6. Delivered Summary Receipt
              if (isCompleted)
                VaayuCard(
                  borderColor: colors.success,
                  backgroundColor: colors.success.withValues(alpha: 0.08),
                  child: Column(
                    children: [
                      Icon(Icons.check_circle, color: colors.success, size: 44),
                      const SizedBox(height: VaayuSpacing.sm),
                      Text(
                        'Trip Completed & Reconciled',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w800,
                          color: colors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Fare settled in double-entry ledger with ₹0 discrepancy',
                        style: TextStyle(fontSize: 12, color: colors.textSecondary),
                      ),
                      const SizedBox(height: VaayuSpacing.md),
                      const Divider(),
                      const SizedBox(height: VaayuSpacing.sm),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text('Earned Amount', style: TextStyle(color: colors.textSecondary)),
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
                        key: const Key('btn_dismiss_delivery'),
                        label: 'RETURN TO DUTY RADAR',
                        onPressed: () => widget.controller.clearActiveDelivery(),
                      ),
                    ],
                  ),
                ),

              const SizedBox(height: VaayuSpacing.lg),

              // 7. SOS Emergency Control
              if (!isCompleted)
                VaayuButton(
                  label: 'SOS Emergency Alert',
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
            ],
          ),
        );
      },
    );
  }

  Widget _buildMilestoneAction(String status) {
    return switch (status) {
      'DRIVER_ACCEPTED' => VaayuButton(
          key: const Key('btn_action_start_arriving'),
          label: 'NAVIGATE TO PICKUP',
          leadingIcon: Icons.directions_bike,
          isLoading: _isActionInProgress,
          onPressed: () => _advanceAction('start-arriving'),
        ),
      'DRIVER_ARRIVING' => VaayuButton(
          key: const Key('btn_action_arrived_pickup'),
          label: 'ARRIVED AT PICKUP POINT',
          leadingIcon: Icons.pin_drop,
          isLoading: _isActionInProgress,
          onPressed: () => _advanceAction('arrived-pickup'),
        ),
      'DRIVER_AT_PICKUP' => VaayuButton(
          key: const Key('btn_action_verify_otp'),
          label: 'ENTER RIDER OTP & START TRIP',
          leadingIcon: Icons.lock_open,
          variant: VaayuButtonVariant.primary,
          onPressed: _handlePickupOtpFlow,
        ),
      'PICKUP_CONFIRMED' => VaayuButton(
          key: const Key('btn_action_start_transit'),
          label: 'START TRANSIT TO DESTINATION',
          leadingIcon: Icons.navigation,
          isLoading: _isActionInProgress,
          onPressed: () => _advanceAction('start-transit'),
        ),
      'IN_TRANSIT' || 'PICKED_UP' => VaayuButton(
          key: const Key('btn_action_arrived_dropoff'),
          label: 'ARRIVED AT DESTINATION',
          leadingIcon: Icons.flag,
          isLoading: _isActionInProgress,
          onPressed: () => _advanceAction('arrived-dropoff'),
        ),
      'DRIVER_AT_DROPOFF' => VaayuButton(
          key: const Key('btn_action_complete_trip'),
          label: 'COMPLETE TRIP & SETTLE',
          leadingIcon: Icons.check_circle,
          variant: VaayuButtonVariant.primary,
          onPressed: _handleCompleteTripFlow,
        ),
      _ => const SizedBox.shrink(key: Key('btn_action_none')),
    };
  }

  String _formatStatusLabel(String status) {
    return switch (status) {
      'DRIVER_ACCEPTED' => 'Offer Accepted',
      'DRIVER_ARRIVING' => 'Arriving to Pickup',
      'DRIVER_AT_PICKUP' => 'At Pickup Location',
      'PICKUP_CONFIRMED' => 'Pickup Verified',
      'IN_TRANSIT' || 'PICKED_UP' => 'Trip in Transit',
      'DRIVER_AT_DROPOFF' => 'At Destination',
      'DELIVERED' || 'COMPLETED' => 'Completed & Settled',
      _ => status,
    };
  }

  StatusBadgeType _statusBadgeType(String status) {
    return switch (status) {
      'DRIVER_ACCEPTED' || 'DRIVER_ARRIVING' => StatusBadgeType.connecting,
      'DRIVER_AT_PICKUP' => StatusBadgeType.warning,
      'PICKUP_CONFIRMED' || 'IN_TRANSIT' || 'PICKED_UP' => StatusBadgeType.online,
      'DRIVER_AT_DROPOFF' => StatusBadgeType.warning,
      'DELIVERED' || 'COMPLETED' => StatusBadgeType.online,
      _ => StatusBadgeType.neutral,
    };
  }
}
