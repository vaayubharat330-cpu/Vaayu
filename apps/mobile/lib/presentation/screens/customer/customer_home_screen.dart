import 'package:flutter/material.dart';
import '../../../core/projection/driver_location_store.dart';
import '../../../core/projection/local_trip_projection.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../../core/websocket/websocket_client.dart';
import '../../common/widgets/status_badge.dart';
import '../../state/customer_trip_controller.dart';
import '../../state/view_state.dart';
import 'customer_booking_sheet.dart';
import 'customer_active_ride_cockpit.dart';

/// Full Customer Experience Home Screen.
/// Seamlessly transitions between Ride Booking and Live Active Ride Cockpit.
class CustomerHomeScreen extends StatelessWidget {
  final CustomerTripController controller;
  final DriverLocationStore locationStore;
  final WebSocketClient webSocketClient;
  final VoidCallback? onLogout;

  const CustomerHomeScreen({
    super.key,
    required this.controller,
    required this.locationStore,
    required this.webSocketClient,
    this.onLogout,
  });

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
              'Rider Cockpit',
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
            stream: webSocketClient.statusStream,
            initialData: webSocketClient.status,
            builder: (context, snapshot) {
              final status = snapshot.data ?? webSocketClient.status;
              final isConnected = status == WebSocketStatus.connected;
              final isReconnecting = status == WebSocketStatus.reconnecting || status == WebSocketStatus.connecting;

              return Padding(
                padding: const EdgeInsets.only(right: VaayuSpacing.sm),
                child: Center(
                  child: StatusBadge.connection(
                    isConnected: isConnected,
                    isReconnecting: isReconnecting,
                  ),
                ),
              );
            },
          ),
          if (onLogout != null)
            IconButton(
              icon: Icon(Icons.logout, size: 20, color: colors.textSecondary),
              tooltip: 'Sign Out',
              onPressed: onLogout,
            ),
        ],
      ),
      body: StreamBuilder<ViewState<LocalTripProjection>>(
        stream: controller.activeTripStream,
        initialData: controller.activeTripState,
        builder: (context, snapshot) {
          final tripState = snapshot.data ?? controller.activeTripState;
          final hasActiveTrip = tripState.data != null;
          final disableAnimations = MediaQuery.disableAnimationsOf(context);

          final Widget content = hasActiveTrip
              ? CustomerActiveRideCockpit(
                  key: const ValueKey('customer_active_cockpit'),
                  controller: controller,
                  locationStore: locationStore,
                )
              : CustomerBookingSheet(
                  key: const ValueKey('customer_booking_sheet'),
                  controller: controller,
                );

          if (disableAnimations) {
            return content;
          }

          return AnimatedSwitcher(
            duration: const Duration(milliseconds: 250),
            switchInCurve: Curves.easeOutCubic,
            switchOutCurve: Curves.easeInCubic,
            child: content,
          );
        },
      ),
    );
  }
}
