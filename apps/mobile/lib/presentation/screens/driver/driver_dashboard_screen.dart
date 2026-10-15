import 'package:flutter/material.dart';
import '../../../core/projection/local_trip_projection.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../../core/websocket/websocket_client.dart';
import '../../../domain/driver/driver_models.dart';
import '../../common/widgets/status_badge.dart';
import '../../common/widgets/vaayu_card.dart';
import '../../state/driver_partner_controller.dart';
import '../../state/view_state.dart';
import 'driver_active_trip_cockpit.dart';
import 'driver_duty_toggle_card.dart';
import 'driver_incoming_offer_sheet.dart';

/// Full Driver-Partner Cockpit Dashboard Screen.
///
/// Seamlessly transitions between:
/// - Duty Mode Management (Online / Offline)
/// - Incoming Dispatch Offer radar & countdown modal
/// - Active Turn-by-Turn Waypoint Navigation Cockpit
class DriverDashboardScreen extends StatefulWidget {
  final DriverPartnerController controller;
  final WebSocketClient webSocketClient;
  final VoidCallback? onLogout;
  final bool enableOfferTimer;

  const DriverDashboardScreen({
    super.key,
    required this.controller,
    required this.webSocketClient,
    this.onLogout,
    this.enableOfferTimer = true,
  });

  @override
  State<DriverDashboardScreen> createState() => _DriverDashboardScreenState();
}

class _DriverDashboardScreenState extends State<DriverDashboardScreen> {
  bool _isTogglingDuty = false;
  bool _isAcceptingOffer = false;

  @override
  void initState() {
    super.initState();
    _loadInitialData();
  }

  void _loadInitialData() {
    widget.controller.loadProfile();
    widget.controller.loadOffers();
  }

  Future<void> _handleDutyToggle(bool targetOnline) async {
    setState(() => _isTogglingDuty = true);
    final status = targetOnline ? 'ONLINE' : 'OFFLINE';
    final success = await widget.controller.setDutyStatus(status);
    if (mounted) {
      setState(() => _isTogglingDuty = false);
      if (!success) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Failed to update duty status. Please try again.'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  Future<void> _handleAcceptOffer(String orderId) async {
    setState(() => _isAcceptingOffer = true);
    try {
      final success = await widget.controller.acceptOffer(orderId);
      if (!mounted) return;
      if (!success) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Unable to accept offer. It may have expired or been assigned.'),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isAcceptingOffer = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);

    return Scaffold(
      appBar: AppBar(
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: colors.primary,
                borderRadius: VaayuRadius.smBorder,
              ),
              child: Text(
                'VAAYU',
                style: TextStyle(
                  color: colors.onPrimary,
                  fontWeight: FontWeight.w900,
                  fontSize: 14,
                  letterSpacing: 1.5,
                ),
              ),
            ),
            const SizedBox(width: VaayuSpacing.sm),
            Text(
              'Driver Cockpit',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: colors.textPrimary,
              ),
            ),
          ],
        ),
        actions: [
          StreamBuilder<WebSocketStatus>(
            stream: widget.webSocketClient.statusStream,
            initialData: widget.webSocketClient.status,
            builder: (context, snapshot) {
              final status = snapshot.data ?? widget.webSocketClient.status;
              final isConnected = status == WebSocketStatus.connected;
              final isReconnecting = status == WebSocketStatus.reconnecting ||
                  status == WebSocketStatus.connecting;

              return Padding(
                padding: const EdgeInsets.only(right: VaayuSpacing.xs),
                child: Center(
                  child: StatusBadge.connection(
                    isConnected: isConnected,
                    isReconnecting: isReconnecting,
                  ),
                ),
              );
            },
          ),
          IconButton(
            icon: Icon(Icons.refresh, size: 20, color: colors.textSecondary),
            tooltip: 'Refresh',
            onPressed: _loadInitialData,
          ),
          if (widget.onLogout != null)
            IconButton(
              icon: Icon(Icons.logout, size: 20, color: colors.textSecondary),
              tooltip: 'Sign Out',
              onPressed: widget.onLogout,
            ),
        ],
      ),
      body: StreamBuilder<ViewState<LocalTripProjection>>(
        stream: widget.controller.activeDeliveryStream,
        initialData: widget.controller.activeDeliveryState,
        builder: (context, activeSnapshot) {
          final activeState = activeSnapshot.data ?? widget.controller.activeDeliveryState;
          final hasActiveDelivery = activeState.data != null;
          final disableAnimations = MediaQuery.disableAnimationsOf(context);

          // 1. If active delivery exists -> Driver Active Trip Cockpit
          final Widget bodyContent = hasActiveDelivery
              ? DriverActiveTripCockpit(
                  key: const ValueKey('driver_active_cockpit'),
                  controller: widget.controller,
                )
              : SingleChildScrollView(
                  key: const ValueKey('driver_duty_view'),
                  padding: const EdgeInsets.all(VaayuSpacing.md),
                  child: StreamBuilder<ViewState<DriverProfile>>(
                    stream: widget.controller.profileStream,
                    initialData: widget.controller.profileState,
                    builder: (context, profileSnapshot) {
                      final profState = profileSnapshot.data ?? widget.controller.profileState;
                      final profile = profState.data;
                      final isOnline = profile?.status == 'ONLINE';

                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          // A. Duty Mode & Stats Card
                          DriverDutyToggleCard(
                            profile: profile,
                            isOnline: isOnline,
                            isLoading: _isTogglingDuty,
                            onToggleDuty: _handleDutyToggle,
                          ),

                          const SizedBox(height: VaayuSpacing.md),

                          // B. Active Offers / Searching Radar
                          if (isOnline)
                            StreamBuilder<ViewState<List<DriverOffer>>>(
                              stream: widget.controller.offersStream,
                              initialData: widget.controller.offersState,
                              builder: (context, offersSnapshot) {
                                final offersState = offersSnapshot.data ?? widget.controller.offersState;
                                final offers = offersState.data ?? [];

                                final Widget offerSection = offers.isNotEmpty
                                    ? DriverIncomingOfferSheet(
                                        key: ValueKey(offers.first.orderId),
                                        offer: offers.first,
                                        isAccepting: _isAcceptingOffer,
                                        enableTimer: widget.enableOfferTimer,
                                        onAccept: () => _handleAcceptOffer(offers.first.orderId),
                                        onDecline: () => widget.controller.declineOffer(offers.first.orderId),
                                      )
                                    : VaayuCard(
                                        key: const ValueKey('driver_radar_card'),
                                        backgroundColor: colors.surface,
                                        child: Padding(
                                          padding: const EdgeInsets.symmetric(vertical: VaayuSpacing.lg),
                                          child: Column(
                                            children: [
                                              SizedBox(
                                                width: 48,
                                                height: 48,
                                                child: Stack(
                                                  alignment: Alignment.center,
                                                  children: [
                                                    CircularProgressIndicator(
                                                      strokeWidth: 2.5,
                                                      valueColor: AlwaysStoppedAnimation<Color>(colors.primary),
                                                    ),
                                                    Icon(Icons.radar, color: colors.primary, size: 24),
                                                  ],
                                                ),
                                              ),
                                              const SizedBox(height: VaayuSpacing.md),
                                              Text(
                                                'Listening for Nearby Ride Broadcasts...',
                                                style: TextStyle(
                                                  fontSize: 15,
                                                  fontWeight: FontWeight.w700,
                                                  color: colors.textPrimary,
                                                ),
                                              ),
                                              const SizedBox(height: 4),
                                              Text(
                                                'High-priority matching queue active in your current zone',
                                                style: TextStyle(fontSize: 12, color: colors.textSecondary),
                                              ),
                                            ],
                                          ),
                                        ),
                                      );

                                if (disableAnimations) {
                                  return offerSection;
                                }

                                return AnimatedSwitcher(
                                  duration: const Duration(milliseconds: 250),
                                  switchInCurve: Curves.easeOutCubic,
                                  switchOutCurve: Curves.easeInCubic,
                                  child: offerSection,
                                );
                              },
                            )
                          else
                            // Offline Notice
                            VaayuCard(
                              key: const ValueKey('driver_offline_notice'),
                              backgroundColor: colors.surface,
                              child: Padding(
                                padding: const EdgeInsets.symmetric(vertical: VaayuSpacing.md),
                                child: Row(
                                  children: [
                                    Icon(Icons.info_outline, color: colors.textTertiary, size: 20),
                                    const SizedBox(width: VaayuSpacing.md),
                                    Expanded(
                                      child: Text(
                                        'You are currently OFFLINE. Switch duty mode online to start receiving ride offers.',
                                        style: TextStyle(fontSize: 12, color: colors.textSecondary),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                        ],
                      );
                    },
                  ),
                );

          if (disableAnimations) {
            return bodyContent;
          }

          return AnimatedSwitcher(
            duration: const Duration(milliseconds: 250),
            switchInCurve: Curves.easeOutCubic,
            switchOutCurve: Curves.easeInCubic,
            child: bodyContent,
          );
        },
      ),
    );
  }
}
