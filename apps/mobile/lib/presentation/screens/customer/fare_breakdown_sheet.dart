import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../../domain/customer/customer_models.dart';
import '../../common/widgets/vaayu_button.dart';
import '../../common/widgets/status_badge.dart';

/// Modal bottom sheet displaying transparent fare breakdown from authoritative server estimate.
class FareBreakdownSheet extends StatelessWidget {
  final FareEstimateResult estimate;

  const FareBreakdownSheet({
    super.key,
    required this.estimate,
  });

  static Future<void> show(BuildContext context, FareEstimateResult estimate) {
    return showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (ctx) => FareBreakdownSheet(estimate: estimate),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);
    final breakdown = estimate.fareBreakdown ?? {};

    final baseFare = (breakdown['baseFare'] as num?)?.toDouble() ?? 40.0;
    final distanceFare = (breakdown['distanceFare'] as num?)?.toDouble() ?? 
        ((estimate.distanceKm ?? 0.0) * 12.0);
    final surgeMultiplier = (breakdown['surgeMultiplier'] as num?)?.toDouble() ?? 1.0;
    final hasSurge = surgeMultiplier > 1.0;
    final totalFare = estimate.estimatedFare ?? (baseFare + distanceFare);

    return Container(
      decoration: BoxDecoration(
        color: colors.surfaceElevated,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(VaayuRadius.xl)),
        border: Border.all(color: colors.border),
      ),
      padding: const EdgeInsets.all(VaayuSpacing.lg),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: colors.border,
                  borderRadius: VaayuRadius.pillBorder,
                ),
              ),
            ),
            const SizedBox(height: VaayuSpacing.md),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Text(
                    'Authoritative Fare Breakdown',
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w700,
                      color: colors.textPrimary,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                if (hasSurge)
                  StatusBadge(
                    label: '${surgeMultiplier.toStringAsFixed(1)}x Surge',
                    type: StatusBadgeType.warning,
                  )
                else
                  const StatusBadge(
                    label: 'Guaranteed',
                    type: StatusBadgeType.online,
                  ),
              ],
            ),
            const SizedBox(height: VaayuSpacing.sm),
            Text(
              'Distance: ${estimate.distanceKm?.toStringAsFixed(1) ?? "--"} km • Duration: ~${estimate.durationMins?.toStringAsFixed(0) ?? "--"} mins',
              style: TextStyle(
                fontSize: 13,
                color: colors.textSecondary,
              ),
            ),
            const SizedBox(height: VaayuSpacing.md),
            const Divider(),
            const SizedBox(height: VaayuSpacing.sm),
            _buildRow('Base Fare', '₹${baseFare.toStringAsFixed(2)}', colors),
            _buildRow('Distance Charge', '₹${distanceFare.toStringAsFixed(2)}', colors),
            if (hasSurge)
              _buildRow(
                'Dynamic Demand Adjustment (${surgeMultiplier.toStringAsFixed(1)}x)',
                'Applied',
                colors,
                valueColor: colors.warning,
              ),
            _buildRow('Platform & Regulatory Compliance', 'Included', colors),
            const SizedBox(height: VaayuSpacing.sm),
            const Divider(),
            const SizedBox(height: VaayuSpacing.sm),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Text(
                    'Total Estimated Fare',
                    style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w800,
                      color: colors.textPrimary,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  '₹${totalFare.toStringAsFixed(2)}',
                  style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w900,
                    color: colors.primary,
                  ),
                ),
              ],
            ),
            const SizedBox(height: VaayuSpacing.md),
            Container(
              padding: const EdgeInsets.all(VaayuSpacing.sm),
              decoration: BoxDecoration(
                color: colors.surface,
                borderRadius: VaayuRadius.mdBorder,
                border: Border.all(color: colors.border),
              ),
              child: Row(
                children: [
                  Icon(Icons.shield_outlined, size: 18, color: colors.primary),
                  const SizedBox(width: VaayuSpacing.sm),
                  Expanded(
                    child: Text(
                      'Price lock guaranteed by VAAYU server authority upon dispatch matching.',
                      style: TextStyle(fontSize: 11, color: colors.textSecondary),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: VaayuSpacing.lg),
            VaayuButton(
              label: 'Close',
              variant: VaayuButtonVariant.outlined,
              onPressed: () => Navigator.of(context).pop(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRow(String label, String value, dynamic colors, {Color? valueColor}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4.0),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Expanded(
            child: Text(label, style: TextStyle(fontSize: 14, color: colors.textSecondary)),
          ),
          const SizedBox(width: 8),
          Text(
            value,
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: valueColor ?? colors.textPrimary,
            ),
          ),
        ],
      ),
    );
  }
}
