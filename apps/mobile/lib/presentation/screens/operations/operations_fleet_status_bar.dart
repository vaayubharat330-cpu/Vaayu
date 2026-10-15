/// E4.2: Fleet Health & Telemetry Status Bar for VAAYU Operations Cockpit.
/// Displays fleet size, online/offline breakdown, utilization, and filter tabs.
library operations_fleet_status_bar;

import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_colors.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../../domain/operations/operations_models.dart';
import '../../common/widgets/metric_chip.dart';
import '../../state/operations_controller.dart';

class OperationsFleetStatusBar extends StatelessWidget {
  final FleetSummary? summary;
  final OperationsFilter activeFilter;
  final void Function(OperationsFilter filter) onFilterChanged;

  const OperationsFleetStatusBar({
    super.key,
    required this.summary,
    required this.activeFilter,
    required this.onFilterChanged,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<VaayuColors>() ?? VaayuColors.dark;

    final total = summary?.totalDrivers ?? 0;
    final online = summary?.onlineCount ?? 0;
    final degraded = (summary?.degradedCount ?? 0) + (summary?.staleCount ?? 0);
    final offline = summary?.offlineCount ?? 0;
    final util = summary?.utilizationPercent ?? 0;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Metric Row
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              MetricChip(
                label: 'TOTAL FLEET',
                value: '$total',
                icon: Icons.local_shipping_outlined,
              ),
              const SizedBox(width: VaayuSpacing.xs),
              MetricChip(
                label: 'ONLINE',
                value: '$online',
                icon: Icons.check_circle_outline,
              ),
              const SizedBox(width: VaayuSpacing.xs),
              MetricChip(
                label: 'STALE / DEGRADED',
                value: '$degraded',
                icon: Icons.warning_amber_rounded,
              ),
              const SizedBox(width: VaayuSpacing.xs),
              MetricChip(
                label: 'OFFLINE',
                value: '$offline',
                icon: Icons.power_settings_new_rounded,
              ),
              const SizedBox(width: VaayuSpacing.xs),
              MetricChip(
                label: 'UTILIZATION',
                value: '$util%',
                icon: Icons.speed_rounded,
              ),
            ],
          ),
        ),
        const SizedBox(height: VaayuSpacing.sm),

        // Filter Bar
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              _buildFilterChip(
                context,
                filter: OperationsFilter.all,
                label: 'All Entities',
                colors: colors,
              ),
              const SizedBox(width: 6),
              _buildFilterChip(
                context,
                filter: OperationsFilter.exceptionsOnly,
                label: '🔴 Exceptions Only',
                colors: colors,
              ),
              const SizedBox(width: 6),
              _buildFilterChip(
                context,
                filter: OperationsFilter.activeTripsOnly,
                label: '🚗 Active Trips',
                colors: colors,
              ),
              const SizedBox(width: 6),
              _buildFilterChip(
                context,
                filter: OperationsFilter.availableDriversOnly,
                label: '🟢 Available Drivers',
                colors: colors,
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildFilterChip(
    BuildContext context, {
    required OperationsFilter filter,
    required String label,
    required VaayuColors colors,
  }) {
    final isSelected = activeFilter == filter;
    return GestureDetector(
      key: Key('filter_chip_${filter.name}'),
      onTap: () => onFilterChanged(filter),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 48.0, minWidth: 48.0),
        child: Center(
          widthFactor: 1.0,
          heightFactor: 1.0,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: isSelected ? colors.primary.withValues(alpha: 0.15) : colors.surfaceElevated,
              borderRadius: BorderRadius.circular(VaayuRadius.sm),
              border: Border.all(
                color: isSelected ? colors.primary : colors.border,
                width: isSelected ? 1.5 : 1,
              ),
            ),
            child: Text(
              label,
              style: TextStyle(
                color: isSelected ? colors.primary : colors.textSecondary,
                fontSize: 11,
                fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
