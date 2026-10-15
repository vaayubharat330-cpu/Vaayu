import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../common/widgets/vaayu_card.dart';
import '../../common/widgets/metric_chip.dart';

class VehicleTierInfo {
  final String id;
  final String title;
  final String subtitle;
  final IconData icon;
  final String capacity;

  const VehicleTierInfo({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.capacity,
  });
}

/// Standardized Vehicle Tier Selector for Customer Ride Booking.
/// Visual presentation only: delegates selection callbacks to controller.
class VehicleTierSelector extends StatelessWidget {
  final String selectedVehicleId;
  final ValueChanged<String> onTierSelected;
  final Map<String, double>? estimatedFares;

  const VehicleTierSelector({
    super.key,
    required this.selectedVehicleId,
    required this.onTierSelected,
    this.estimatedFares,
  });

  static const List<VehicleTierInfo> availableTiers = [
    VehicleTierInfo(
      id: 'v_2w',
      title: 'Vaayu Moto',
      subtitle: 'Fast 2-Wheeler ride',
      icon: Icons.two_wheeler,
      capacity: '1 Person',
    ),
    VehicleTierInfo(
      id: 'v_3w',
      title: 'Vaayu Auto',
      subtitle: 'Accessible 3-Wheeler ride',
      icon: Icons.electric_rickshaw,
      capacity: '3 Persons',
    ),
    VehicleTierInfo(
      id: 'v_ace',
      title: 'Vaayu Express',
      subtitle: 'Spacious Mini Carrier',
      icon: Icons.local_shipping_outlined,
      capacity: '750 kg',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Select Ride Tier',
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w700,
            color: colors.textPrimary,
          ),
        ),
        const SizedBox(height: VaayuSpacing.sm),
        ...availableTiers.map((tier) {
          final isSelected = tier.id == selectedVehicleId;
          final fare = estimatedFares?[tier.id];

          return Padding(
            padding: const EdgeInsets.only(bottom: VaayuSpacing.sm),
            child: VaayuCard(
              onTap: () => onTierSelected(tier.id),
              borderColor: isSelected ? colors.primary : colors.border,
              backgroundColor: isSelected ? colors.primary.withValues(alpha: 0.08) : colors.surfaceElevated,
              padding: const EdgeInsets.symmetric(horizontal: VaayuSpacing.md, vertical: VaayuSpacing.sm * 1.5),
              child: Row(
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: isSelected ? colors.primary.withValues(alpha: 0.15) : colors.surface,
                      borderRadius: VaayuRadius.mdBorder,
                    ),
                    child: Icon(
                      tier.icon,
                      color: isSelected ? colors.primary : colors.textPrimary,
                      size: 26,
                    ),
                  ),
                  const SizedBox(width: VaayuSpacing.md),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          tier.title,
                          style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w700,
                            color: colors.textPrimary,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '${tier.subtitle} • ${tier.capacity}',
                          style: TextStyle(
                            fontSize: 12,
                            color: colors.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (fare != null)
                    MetricChip(
                      value: '₹${fare.toStringAsFixed(0)}',
                      accentColor: isSelected ? colors.primary : colors.textPrimary,
                    )
                  else
                    Icon(
                      isSelected ? Icons.radio_button_checked : Icons.radio_button_off,
                      color: isSelected ? colors.primary : colors.textTertiary,
                      size: 20,
                    ),
                ],
              ),
            ),
          );
        }),
      ],
    );
  }
}
