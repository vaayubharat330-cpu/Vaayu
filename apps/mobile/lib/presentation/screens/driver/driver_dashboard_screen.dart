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
import 'driver_kyc_camera_screen.dart';
import 'live_camera_share_screen.dart';

class DriverDashboardScreen extends StatefulWidget {
  final DriverPartnerController controller;
  final WebSocketClient webSocketClient;
  final VoidCallback? onLogout;
  final bool enableOfferTimer;
  const DriverDashboardScreen({super.key, required this.controller, required this.webSocketClient, this.onLogout, this.enableOfferTimer = true});
  @override
  State<DriverDashboardScreen> createState() => _DriverDashboardScreenState();
}

class _DriverDashboardScreenState extends State<DriverDashboardScreen> {
  bool _isTogglingDuty = false;
  bool _isAcceptingOffer = false;

  @override
  void initState() { super.initState(); _loadInitialData(); }
  void _loadInitialData() { widget.controller.loadProfile(); widget.controller.loadOffers(); }

  Future<void> _handleDutyToggle(bool targetOnline) async {
    setState(() => _isTogglingDuty = true);
    final success = await widget.controller.setDutyStatus(targetOnline ? 'ONLINE' : 'OFFLINE');
    if (!mounted) return;
    setState(() => _isTogglingDuty = false);
    if (!success) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Failed to update duty status. Please try again.')));
  }

  Future<void> _handleAcceptOffer(String orderId) async {
    setState(() => _isAcceptingOffer = true);
    try {
      final success = await widget.controller.acceptOffer(orderId);
      if (mounted && !success) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Unable to accept offer. It may have expired or been assigned.')));
    } finally { if (mounted) setState(() => _isAcceptingOffer = false); }
  }

  void _openKyc() {
    final driverId = widget.controller.profileState.data?.id;
    if (driverId == null || driverId.isEmpty) { ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Driver profile is still loading.'))); return; }
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => DriverKycCameraScreen(apiClient: widget.controller.apiClient, driverId: driverId)));
  }

  void _openLiveCamera(String tripId) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => LiveCameraShareScreen(apiClient: widget.controller.apiClient, tripId: tripId)));

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);
    return Scaffold(
      appBar: AppBar(
        title: Row(children: [Container(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4), decoration: BoxDecoration(color: colors.primary, borderRadius: VaayuRadius.smBorder), child: Text('VAAYU', style: TextStyle(color: colors.onPrimary, fontWeight: FontWeight.w900, fontSize: 14, letterSpacing: 1.5))), const SizedBox(width: VaayuSpacing.sm), Text('Driver Cockpit', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: colors.textPrimary))]),
        actions: [
          StreamBuilder<WebSocketStatus>(stream: widget.webSocketClient.statusStream, initialData: widget.webSocketClient.status, builder: (context, snapshot) { final status = snapshot.data ?? widget.webSocketClient.status; return Padding(padding: const EdgeInsets.only(right: VaayuSpacing.xs), child: Center(child: StatusBadge.connection(isConnected: status == WebSocketStatus.connected, isReconnecting: status == WebSocketStatus.reconnecting || status == WebSocketStatus.connecting))); }),
          IconButton(icon: Icon(Icons.verified_user_outlined, color: colors.textSecondary), tooltip: 'KYC & documents', onPressed: _openKyc),
          StreamBuilder<ViewState<LocalTripProjection>>(stream: widget.controller.activeDeliveryStream, initialData: widget.controller.activeDeliveryState, builder: (context, snapshot) { final trip = (snapshot.data ?? widget.controller.activeDeliveryState).data; return IconButton(icon: Icon(Icons.videocam_outlined, color: trip == null ? colors.textTertiary : colors.primary), tooltip: 'Live camera', onPressed: trip == null ? null : () => _openLiveCamera(trip.tripId)); }),
          IconButton(icon: Icon(Icons.refresh, size: 20, color: colors.textSecondary), tooltip: 'Refresh', onPressed: _loadInitialData),
          if (widget.onLogout != null) IconButton(icon: Icon(Icons.logout, size: 20, color: colors.textSecondary), tooltip: 'Sign Out', onPressed: widget.onLogout),
        ],
      ),
      body: StreamBuilder<ViewState<LocalTripProjection>>(
        stream: widget.controller.activeDeliveryStream,
        initialData: widget.controller.activeDeliveryState,
        builder: (context, activeSnapshot) {
          final active = activeSnapshot.data ?? widget.controller.activeDeliveryState;
          if (active.data != null) return DriverActiveTripCockpit(key: const ValueKey('driver_active_cockpit'), controller: widget.controller);
          return SingleChildScrollView(padding: const EdgeInsets.all(VaayuSpacing.md), child: StreamBuilder<ViewState<DriverProfile>>(
            stream: widget.controller.profileStream,
            initialData: widget.controller.profileState,
            builder: (context, profileSnapshot) {
              final profile = (profileSnapshot.data ?? widget.controller.profileState).data;
              final isOnline = profile?.status == 'ONLINE';
              return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                DriverDutyToggleCard(profile: profile, isOnline: isOnline, isLoading: _isTogglingDuty, onToggleDuty: _handleDutyToggle),
                const SizedBox(height: VaayuSpacing.md),
                VaayuCard(backgroundColor: colors.surface, child: ListTile(leading: Icon(Icons.verified_user_outlined, color: colors.primary), title: const Text('Identity & KYC', style: TextStyle(fontWeight: FontWeight.w800)), subtitle: Text(profile?.kycStatus == 'APPROVED' ? 'KYC approved' : 'Complete document verification before commercial duty', style: const TextStyle(fontSize: 12)), trailing: const Icon(Icons.chevron_right), onTap: _openKyc)),
                const SizedBox(height: VaayuSpacing.md),
                if (isOnline) StreamBuilder<ViewState<List<DriverOffer>>>(stream: widget.controller.offersStream, initialData: widget.controller.offersState, builder: (context, offersSnapshot) {
                  final offers = (offersSnapshot.data ?? widget.controller.offersState).data ?? <DriverOffer>[];
                  return offers.isNotEmpty ? DriverIncomingOfferSheet(key: ValueKey(offers.first.orderId), offer: offers.first, isAccepting: _isAcceptingOffer, enableTimer: widget.enableOfferTimer, onAccept: () => _handleAcceptOffer(offers.first.orderId), onDecline: () => widget.controller.declineOffer(offers.first.orderId)) : VaayuCard(backgroundColor: colors.surface, child: Padding(padding: const EdgeInsets.symmetric(vertical: VaayuSpacing.lg), child: Column(children: [Icon(Icons.radar, color: colors.primary, size: 40), const SizedBox(height: VaayuSpacing.md), Text('Listening for Nearby Dispatch Offers', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: colors.textPrimary)), const SizedBox(height: 4), Text('The authoritative dispatch queue is active in your current zone', style: TextStyle(fontSize: 12, color: colors.textSecondary))])));
                }) else VaayuCard(backgroundColor: colors.surface, child: Padding(padding: const EdgeInsets.symmetric(vertical: VaayuSpacing.md), child: Row(children: [Icon(Icons.info_outline, color: colors.textTertiary, size: 20), const SizedBox(width: VaayuSpacing.md), Expanded(child: Text('You are currently OFFLINE. Switch duty mode online to start receiving commercial delivery offers.', style: TextStyle(fontSize: 12, color: colors.textSecondary)))]))),
              ]);
            },
          ));
        },
      ),
    );
  }
}
