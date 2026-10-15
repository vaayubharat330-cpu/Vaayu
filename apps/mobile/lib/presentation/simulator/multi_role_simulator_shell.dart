/// Post-Certification Product Validation Track:
/// VAAYU Multi-Role Simulator & Scenario Harness Dev Shell.
/// Allows live dev-mode switching across Customer, Driver, Operations, and Scenario Runner.
library multi_role_simulator_shell;

import 'package:flutter/material.dart';
import '../../core/models/auth_session.dart';
import '../../core/projection/driver_location_store.dart';
import '../../core/projection/projection_store.dart';
import '../../core/session/session_manager.dart';
import '../../core/theme/vaayu_colors.dart';
import '../../core/theme/vaayu_tokens.dart';
import '../../core/websocket/websocket_client.dart';
import '../../domain/simulator/scenario_models.dart';
import '../../domain/simulator/scenario_runner.dart';
import '../common/widgets/status_badge.dart';
import '../common/widgets/vaayu_button.dart';
import '../common/widgets/vaayu_card.dart';
import '../navigation/app_router.dart';
import '../screens/customer/customer_home_screen.dart';
import '../screens/driver/driver_dashboard_screen.dart';
import '../screens/operations/operations_dashboard_screen.dart';
import '../state/customer_trip_controller.dart';
import '../state/driver_partner_controller.dart';
import '../state/operations_controller.dart';

enum SimulatorTab {
  customer,
  driver,
  operations,
  scenarios,
}

class MultiRoleSimulatorShell extends StatefulWidget {
  final CustomerTripController customerController;
  final DriverPartnerController driverController;
  final OperationsController operationsController;
  final ScenarioRunner scenarioRunner;
  final SessionManager sessionManager;
  final AppRouter router;
  final LocalTripProjectionStore projectionStore;
  final DriverLocationStore locationStore;
  final WebSocketClient webSocketClient;
  final SimulatorTab initialTab;

  const MultiRoleSimulatorShell({
    super.key,
    required this.customerController,
    required this.driverController,
    required this.operationsController,
    required this.scenarioRunner,
    required this.sessionManager,
    required this.router,
    required this.projectionStore,
    required this.locationStore,
    required this.webSocketClient,
    this.initialTab = SimulatorTab.customer,
  });

  @override
  State<MultiRoleSimulatorShell> createState() => _MultiRoleSimulatorShellState();
}

class _MultiRoleSimulatorShellState extends State<MultiRoleSimulatorShell> {
  late SimulatorTab _currentTab;
  final Map<String, ScenarioRunReport> _scenarioReports = {};
  bool _isRunningScenario = false;
  String? _activeScenarioId;

  @override
  void initState() {
    super.initState();
    _currentTab = widget.initialTab;
    _syncSessionForTab(_currentTab);
  }

  Future<void> _syncSessionForTab(SimulatorTab tab) async {
    final now = DateTime.now();
    AuthSession session;
    switch (tab) {
      case SimulatorTab.customer:
        session = AuthSession(
          userId: 'usr_cust_sim_01',
          token: 'sim_customer_token',
          role: 'CUSTOMER',
          name: 'Priya Sharma (Rider)',
          phone: '+919999900001',
          city: 'Hyderabad',
          issuedAt: now,
          expiresAt: now.add(const Duration(hours: 24)),
        );
        break;
      case SimulatorTab.driver:
        session = AuthSession(
          userId: 'usr_drv_sim_01',
          token: 'sim_driver_token',
          role: 'DRIVER',
          name: 'Kiran Pilot (Driver)',
          phone: '+917842416560',
          city: 'Hyderabad',
          issuedAt: now,
          expiresAt: now.add(const Duration(hours: 24)),
        );
        break;
      case SimulatorTab.operations:
      case SimulatorTab.scenarios:
        session = AuthSession(
          userId: 'usr_admin_sim_01',
          token: 'sim_admin_token',
          role: 'DISPATCH_OPERATOR',
          name: 'Control Tower Operator',
          phone: '+919876543210',
          city: 'Hyderabad',
          issuedAt: now,
          expiresAt: now.add(const Duration(hours: 24)),
        );
        break;
    }

    await widget.sessionManager.establishSession(session);
    widget.router.updateSession(session);
    if (mounted) setState(() {});
  }

  void _onTabSelected(SimulatorTab tab) {
    setState(() => _currentTab = tab);
    _syncSessionForTab(tab);
  }

  Future<void> _executeScenario(String scenarioId) async {
    setState(() {
      _isRunningScenario = true;
      _activeScenarioId = scenarioId;
    });

    final report = await widget.scenarioRunner.runScenario(scenarioId);

    if (mounted) {
      setState(() {
        _scenarioReports[scenarioId] = report;
        _isRunningScenario = false;
        _activeScenarioId = null;
      });
    }
  }

  Future<void> _runAllScenarios() async {
    setState(() => _isRunningScenario = true);
    for (final def in ScenarioRunner.definitions) {
      setState(() => _activeScenarioId = def.id);
      final report = await widget.scenarioRunner.runScenario(def.id);
      if (mounted) {
        setState(() => _scenarioReports[def.id] = report);
      }
    }
    if (mounted) {
      setState(() {
        _isRunningScenario = false;
        _activeScenarioId = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<VaayuColors>() ?? VaayuColors.dark;

    final activeTrip = widget.projectionStore.currentTrip;
    final activeTripId = activeTrip?.tripId;
    final activeVersion = activeTrip?.version;
    final activeStatus = activeTrip?.status ?? 'IDLE';
    final latestGps = activeTripId != null ? widget.locationStore.getLocation(activeTripId) : null;
    final gpsSeq = latestGps?.sequence;

    return Scaffold(
      backgroundColor: colors.background,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(48),
        child: Container(
          color: colors.surface,
          padding: const EdgeInsets.symmetric(horizontal: VaayuSpacing.sm, vertical: 6),
          child: SafeArea(
            bottom: false,
            child: Row(
              children: [
                // Simulator Mode Tag
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: colors.secondary.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: colors.secondary.withValues(alpha: 0.4)),
                  ),
                  child: Text(
                    'SIMULATOR',
                    style: TextStyle(
                      color: colors.secondary,
                      fontWeight: FontWeight.bold,
                      fontSize: 10,
                      letterSpacing: 0.6,
                    ),
                  ),
                ),
                const SizedBox(width: 8),

                // Active Trip & Monotonic Version Pill
                if (activeTripId != null) ...[
                  Flexible(
                    child: Text(
                      activeTripId,
                      overflow: TextOverflow.ellipsis,
                      maxLines: 1,
                      style: TextStyle(
                        color: colors.textPrimary,
                        fontFamily: 'monospace',
                        fontWeight: FontWeight.bold,
                        fontSize: 11,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                    decoration: BoxDecoration(
                      color: colors.primary.withValues(alpha: 0.2),
                      borderRadius: BorderRadius.circular(3),
                    ),
                    child: Text(
                      'v$activeVersion',
                      style: TextStyle(
                        color: colors.primary,
                        fontWeight: FontWeight.bold,
                        fontFamily: 'monospace',
                        fontSize: 10,
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  if (gpsSeq != null)
                    Text(
                      '#$gpsSeq',
                      style: TextStyle(
                        color: colors.secondary,
                        fontFamily: 'monospace',
                        fontSize: 10,
                      ),
                    ),
                  const SizedBox(width: 6),
                  StatusBadge(
                    label: activeStatus,
                    type: StatusBadgeType.online,
                  ),
                ] else ...[
                  Text(
                    'Fleet Idle',
                    style: TextStyle(color: colors.textTertiary, fontSize: 11),
                  ),
                ],

                const Spacer(),

                // Ledger Parity Read-Only Chip
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: colors.success.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    '₹0.00 LEDGER',
                    style: TextStyle(
                      color: colors.success,
                      fontWeight: FontWeight.bold,
                      fontSize: 10,
                      letterSpacing: 0.4,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
      body: _buildActiveSurface(),
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: colors.surface,
          border: Border(top: BorderSide(color: colors.border)),
        ),
        child: SafeArea(
          top: false,
          child: Row(
            children: [
              _buildTabItem(
                tab: SimulatorTab.customer,
                icon: Icons.person_pin_circle_outlined,
                label: 'Rider',
                key: 'tab_simulator_customer',
                colors: colors,
              ),
              _buildTabItem(
                tab: SimulatorTab.driver,
                icon: Icons.local_taxi_rounded,
                label: 'Driver',
                key: 'tab_simulator_driver',
                colors: colors,
              ),
              _buildTabItem(
                tab: SimulatorTab.operations,
                icon: Icons.radar_rounded,
                label: 'Control Tower',
                key: 'tab_simulator_operations',
                colors: colors,
              ),
              _buildTabItem(
                tab: SimulatorTab.scenarios,
                icon: Icons.science_outlined,
                label: 'Scenarios',
                key: 'tab_simulator_scenarios',
                colors: colors,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildActiveSurface() {
    switch (_currentTab) {
      case SimulatorTab.customer:
        return CustomerHomeScreen(
          controller: widget.customerController,
          locationStore: widget.locationStore,
          webSocketClient: widget.webSocketClient,
        );
      case SimulatorTab.driver:
        return DriverDashboardScreen(
          controller: widget.driverController,
          webSocketClient: widget.webSocketClient,
          enableOfferTimer: false,
        );
      case SimulatorTab.operations:
        return OperationsDashboardScreen(
          controller: widget.operationsController,
          autoLoad: true,
        );
      case SimulatorTab.scenarios:
        return _buildScenarioHarnessView();
    }
  }

  Widget _buildScenarioHarnessView() {
    final colors = Theme.of(context).extension<VaayuColors>() ?? VaayuColors.dark;

    final passedCount = _scenarioReports.values.where((r) => r.success).length;
    final totalRun = _scenarioReports.length;

    return ListView(
      padding: const EdgeInsets.all(VaayuSpacing.md),
      children: [
        // Master Runner Card
        VaayuCard(
          padding: const EdgeInsets.all(VaayuSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.fact_check_outlined, color: colors.secondary, size: 22),
                  const SizedBox(width: 8),
                  Text(
                    'DETERMINISTIC SCENARIO HARNESS',
                    style: TextStyle(
                      color: colors.textPrimary,
                      fontWeight: FontWeight.bold,
                      fontSize: 13,
                      letterSpacing: 0.8,
                    ),
                  ),
                  const Spacer(),
                  if (totalRun > 0)
                    Text(
                      '$passedCount / $totalRun PASSED',
                      style: TextStyle(
                        color: passedCount == totalRun ? colors.success : colors.danger,
                        fontWeight: FontWeight.bold,
                        fontSize: 11,
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                'Executes the 10 cross-surface lifecycle scenarios against the real backend APIs, testing observable consequences on Customer, Driver, Operations, and Ledger simultaneously.',
                style: TextStyle(color: colors.textSecondary, fontSize: 12),
              ),
              const SizedBox(height: VaayuSpacing.sm),
              VaayuButton(
                key: const Key('btn_run_all_scenarios'),
                label: _isRunningScenario ? 'EXECUTING SCENARIOS...' : 'RUN ALL 10 SCENARIOS',
                isLoading: _isRunningScenario,
                onPressed: _isRunningScenario ? null : _runAllScenarios,
              ),
            ],
          ),
        ),
        const SizedBox(height: VaayuSpacing.md),

        // Scenario List
        ...ScenarioRunner.definitions.map((def) {
          final report = _scenarioReports[def.id];
          final isActive = _activeScenarioId == def.id;

          return Padding(
            padding: const EdgeInsets.only(bottom: VaayuSpacing.sm),
            child: VaayuCard(
              key: Key('card_${def.id}'),
              padding: const EdgeInsets.all(VaayuSpacing.sm),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: colors.border.withValues(alpha: 0.25),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          def.id,
                          style: TextStyle(
                            color: colors.secondary,
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                            fontFamily: 'monospace',
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          def.title,
                          style: TextStyle(
                            color: colors.textPrimary,
                            fontWeight: FontWeight.bold,
                            fontSize: 13,
                          ),
                        ),
                      ),
                      if (report != null) ...[
                        StatusBadge(
                          label: report.success ? 'PASS' : 'FAIL',
                          type: report.success ? StatusBadgeType.online : StatusBadgeType.danger,
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    def.description,
                    style: TextStyle(color: colors.textSecondary, fontSize: 11),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Expect: ${def.expectedOutcome}',
                    style: TextStyle(color: colors.textTertiary, fontSize: 10, fontStyle: FontStyle.italic),
                  ),

                  // Report Details
                  if (report != null) ...[
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: colors.surface,
                        borderRadius: BorderRadius.circular(VaayuRadius.sm),
                        border: Border.all(color: colors.border),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Duration: ${report.totalDurationMs}ms | Steps: ${report.steps.length}',
                            style: TextStyle(
                              color: colors.secondary,
                              fontSize: 10,
                              fontFamily: 'monospace',
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 4),
                          ...report.steps.map((s) => Padding(
                                padding: const EdgeInsets.only(top: 2),
                                child: Row(
                                  children: [
                                    Icon(
                                      s.success ? Icons.check_circle : Icons.error_outline,
                                      size: 12,
                                      color: s.success ? colors.success : colors.danger,
                                    ),
                                    const SizedBox(width: 6),
                                    Text(
                                      '[${s.surface.name.toUpperCase()}] ${s.title}: ',
                                      style: TextStyle(
                                        color: colors.textPrimary,
                                        fontWeight: FontWeight.bold,
                                        fontSize: 10,
                                      ),
                                    ),
                                    Expanded(
                                      child: Text(
                                        s.details,
                                        style: TextStyle(color: colors.textSecondary, fontSize: 10),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                  ],
                                ),
                              )),
                        ],
                      ),
                    ),
                  ],

                  const SizedBox(height: 8),
                  Align(
                    alignment: Alignment.centerRight,
                    child: VaayuButton(
                      key: Key('btn_run_${def.id}'),
                      label: isActive ? 'RUNNING...' : 'RUN SCENARIO',
                      isFullWidth: false,
                      variant: VaayuButtonVariant.secondary,
                      isLoading: isActive,
                      onPressed: _isRunningScenario ? null : () => _executeScenario(def.id),
                    ),
                  ),
                ],
              ),
            ),
          );
        }),
      ],
    );
  }

  Widget _buildTabItem({
    required SimulatorTab tab,
    required IconData icon,
    required String label,
    required String key,
    required VaayuColors colors,
  }) {
    final isSelected = _currentTab == tab;
    return Expanded(
      child: GestureDetector(
        key: Key(key),
        behavior: HitTestBehavior.opaque,
        onTap: () => _onTabSelected(tab),
        child: Container(
          constraints: const BoxConstraints(minHeight: 48.0),
          padding: const EdgeInsets.symmetric(vertical: 6),
          color: Colors.transparent,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                icon,
                size: 20,
                color: isSelected ? colors.primary : colors.textTertiary,
              ),
              const SizedBox(height: 3),
              Text(
                label,
                style: TextStyle(
                  color: isSelected ? colors.primary : colors.textTertiary,
                  fontSize: 10,
                  fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
