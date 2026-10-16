/// VAAYU Operations & Live Fleet Monitoring Cockpit Screen.
library operations_dashboard_screen;

import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_colors.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../../domain/operations/operations_models.dart';
import '../../state/operations_controller.dart';
import '../driver/live_camera_share_screen.dart';
import 'operations_incident_wall.dart';
import 'operations_fleet_status_bar.dart';
import 'operations_live_cards.dart';
import 'operations_intervention_dialog.dart';

class OperationsDashboardScreen extends StatefulWidget {
  final OperationsController controller;
  final bool autoLoad;
  const OperationsDashboardScreen({super.key, required this.controller, this.autoLoad = true});
  @override
  State<OperationsDashboardScreen> createState() => _OperationsDashboardScreenState();
}

class _OperationsDashboardScreenState extends State<OperationsDashboardScreen> {
  @override
  void initState() { super.initState(); if (widget.autoLoad) widget.controller.loadDashboardData(); }
  void _openInterventionDialog(String orderId, {OperatorActionType initialAction = OperatorActionType.redispatch}) { OperationsInterventionDialog.show(context, orderId: orderId, initialAction: initialAction, onConfirm: ({required action, required orderId, driverId, reason}) async { switch (action) { case OperatorActionType.redispatch: return widget.controller.reDispatchTrip(orderId, reason: reason); case OperatorActionType.assignDriver: if (driverId == null) return false; return widget.controller.manualAssignDriver(orderId, driverId); case OperatorActionType.cancelOverride: return widget.controller.cancelTripOverride(orderId, reason: reason); } }); }
  void _openCamera(String tripId) { Navigator.of(context).push(MaterialPageRoute(builder: (_) => LiveCameraShareScreen(apiClient: widget.controller.apiClient, tripId: tripId, viewerOnly: true))); }
  Widget _tripCard(ActiveTripSummary trip) => Padding(padding: const EdgeInsets.only(bottom: VaayuSpacing.xs), child: OperationsTripCard(key: Key('trip_card_${trip.id}'), trip: trip, onIntervene: _openInterventionDialog, onLiveCamera: _openCamera));
  Widget _sectionHeader(String title, VaayuColors colors) => Row(children: [Text(title, style: TextStyle(color: colors.textSecondary, fontWeight: FontWeight.bold, letterSpacing: 0.8, fontSize: 11)), const SizedBox(width: 8), Expanded(child: Divider(color: colors.divider))]);
  Widget _empty(String message, VaayuColors colors) => Padding(padding: const EdgeInsets.symmetric(vertical: VaayuSpacing.md), child: Center(child: Text(message, style: TextStyle(color: colors.textTertiary, fontSize: 12))));

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<VaayuColors>() ?? VaayuColors.dark;
    return AnimatedBuilder(animation: widget.controller, builder: (context, _) {
      final alerts = widget.controller.prioritizedAlerts; final summary = widget.controller.fleetSummaryState.data; final drivers = widget.controller.driversState.data ?? []; final trips = widget.controller.activeTripsState.data ?? []; final filter = widget.controller.activeFilter; final isRefreshing = widget.controller.isRefreshing;
      return Scaffold(backgroundColor: colors.background, appBar: AppBar(backgroundColor: colors.surface, elevation: 0, title: Row(children: [Icon(Icons.radar_rounded, color: colors.secondary, size: 22), const SizedBox(width: 8), Text('CONTROL TOWER', style: TextStyle(color: colors.textPrimary, fontWeight: FontWeight.bold, letterSpacing: 1.0, fontSize: 15))]), actions: [IconButton(key: const Key('btn_ops_refresh'), icon: isRefreshing ? SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: colors.primary)) : Icon(Icons.refresh, color: colors.textSecondary, size: 20), onPressed: isRefreshing ? null : widget.controller.refresh)]), body: RefreshIndicator(color: colors.primary, backgroundColor: colors.surfaceElevated, onRefresh: widget.controller.refresh, child: ListView(padding: const EdgeInsets.all(VaayuSpacing.md), children: [
        OperationsIncidentWall(alerts: alerts, onAssignDriver: (id) => _openInterventionDialog(id, initialAction: OperatorActionType.assignDriver), onRedispatch: (id) => _openInterventionDialog(id), onCancelOverride: (id) => _openInterventionDialog(id, initialAction: OperatorActionType.cancelOverride)),
        const SizedBox(height: VaayuSpacing.md), OperationsFleetStatusBar(summary: summary, activeFilter: filter, onFilterChanged: widget.controller.setFilter), const SizedBox(height: VaayuSpacing.md),
        if (filter == OperationsFilter.exceptionsOnly) ...[_sectionHeader('STALLED / AT-RISK TRIPS (${trips.length})', colors), const SizedBox(height: VaayuSpacing.xs), if (trips.isEmpty) _empty('Zero stalled trips', colors) else ...trips.map(_tripCard)]
        else if (filter == OperationsFilter.activeTripsOnly) ...[_sectionHeader('ACTIVE IN-FLIGHT TRIPS (${trips.length})', colors), const SizedBox(height: VaayuSpacing.xs), if (trips.isEmpty) _empty('No active trips currently in transit', colors) else ...trips.map(_tripCard)]
        else if (filter == OperationsFilter.availableDriversOnly) ...[_sectionHeader('AVAILABLE DRIVERS (${drivers.where((d) => !d.isReserved && d.dutyStatus == 'ONLINE').length})', colors), const SizedBox(height: VaayuSpacing.xs), ...drivers.where((d) => !d.isReserved && d.dutyStatus == 'ONLINE').map((d) => Padding(padding: const EdgeInsets.only(bottom: VaayuSpacing.xs), child: OperationsDriverCard(key: Key('driver_card_${d.driverId}'), driver: d)))]
        else ...[_sectionHeader('ACTIVE TRIPS (${trips.length})', colors), const SizedBox(height: VaayuSpacing.xs), if (trips.isEmpty) _empty('No active trips currently in transit', colors) else ...trips.take(5).map(_tripCard), const SizedBox(height: VaayuSpacing.md), _sectionHeader('LIVE FLEET DRIVERS (${drivers.length})', colors), const SizedBox(height: VaayuSpacing.xs), ...drivers.map((d) => Padding(padding: const EdgeInsets.only(bottom: VaayuSpacing.xs), child: OperationsDriverCard(key: Key('driver_card_${d.driverId}'), driver: d)))]
      ])));
    });
  }
}
