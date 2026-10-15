/// E4.4: Operator Intervention Dialog for VAAYU Operations Cockpit.
/// Allows operators to safely command driver assignment, re-dispatch, or cancel overrides.
library operations_intervention_dialog;

import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_colors.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../common/widgets/vaayu_button.dart';

enum OperatorActionType {
  redispatch,
  assignDriver,
  cancelOverride,
}

class OperationsInterventionDialog extends StatefulWidget {
  final String orderId;
  final OperatorActionType initialAction;
  final Future<bool> Function({
    required OperatorActionType action,
    required String orderId,
    String? driverId,
    String? reason,
  }) onConfirm;

  const OperationsInterventionDialog({
    super.key,
    required this.orderId,
    this.initialAction = OperatorActionType.redispatch,
    required this.onConfirm,
  });

  static Future<bool?> show(
    BuildContext context, {
    required String orderId,
    OperatorActionType initialAction = OperatorActionType.redispatch,
    required Future<bool> Function({
      required OperatorActionType action,
      required String orderId,
      String? driverId,
      String? reason,
    }) onConfirm,
  }) {
    final disableAnimations = MediaQuery.disableAnimationsOf(context);
    return showGeneralDialog<bool>(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'OperationsInterventionDialog',
      barrierColor: Colors.black54,
      transitionDuration: disableAnimations ? Duration.zero : const Duration(milliseconds: 250),
      pageBuilder: (ctx, anim1, anim2) => OperationsInterventionDialog(
        orderId: orderId,
        initialAction: initialAction,
        onConfirm: onConfirm,
      ),
      transitionBuilder: (ctx, anim, secondaryAnim, child) {
        if (disableAnimations) return child;
        final curved = CurvedAnimation(parent: anim, curve: Curves.easeOutCubic);
        return FadeTransition(
          opacity: curved,
          child: ScaleTransition(
            scale: Tween<double>(begin: 0.94, end: 1.0).animate(curved),
            child: child,
          ),
        );
      },
    );
  }

  @override
  State<OperationsInterventionDialog> createState() => _OperationsInterventionDialogState();
}

class _OperationsInterventionDialogState extends State<OperationsInterventionDialog> {
  late OperatorActionType _selectedAction;
  final TextEditingController _inputController = TextEditingController();
  bool _isSubmitting = false;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _selectedAction = widget.initialAction;
    if (_selectedAction == OperatorActionType.redispatch) {
      _inputController.text = 'Operator manual re-dispatch';
    } else if (_selectedAction == OperatorActionType.cancelOverride) {
      _inputController.text = 'Operator safety override';
    }
  }

  @override
  void dispose() {
    _inputController.dispose();
    super.dispose();
  }

  Future<void> _handleSubmit() async {
    final text = _inputController.text.trim();
    if (_selectedAction == OperatorActionType.assignDriver && text.isEmpty) {
      setState(() => _errorMessage = 'Driver ID is required for manual assignment');
      return;
    }
    if ((_selectedAction == OperatorActionType.redispatch || _selectedAction == OperatorActionType.cancelOverride) && text.isEmpty) {
      setState(() => _errorMessage = 'Reason is required for audit logs');
      return;
    }

    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    final success = await widget.onConfirm(
      action: _selectedAction,
      orderId: widget.orderId,
      driverId: _selectedAction == OperatorActionType.assignDriver ? text : null,
      reason: _selectedAction != OperatorActionType.assignDriver ? text : null,
    );

    if (mounted) {
      setState(() => _isSubmitting = false);
      if (success) {
        Navigator.of(context).pop(true);
      } else {
        setState(() => _errorMessage = 'Command rejected by backend authority.');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<VaayuColors>() ?? VaayuColors.dark;

    return Dialog(
      backgroundColor: colors.surfaceElevated,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(VaayuRadius.lg),
        side: BorderSide(color: colors.border),
      ),
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(VaayuSpacing.md),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.admin_panel_settings_outlined, color: colors.secondary, size: 20),
                const SizedBox(width: 8),
                Text(
                  'OPERATOR COMMAND',
                  style: TextStyle(
                    color: colors.secondary,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 0.8,
                    fontSize: 12,
                  ),
                ),
                const Spacer(),
                GestureDetector(
                  onTap: () => Navigator.of(context).pop(false),
                  child: Container(
                    padding: const EdgeInsets.all(10),
                    color: Colors.transparent,
                    child: Icon(Icons.close, color: colors.textTertiary, size: 18),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              'Trip Order: ${widget.orderId}',
              style: TextStyle(
                color: colors.textPrimary,
                fontFamily: 'monospace',
                fontWeight: FontWeight.bold,
                fontSize: 14,
              ),
            ),
            const SizedBox(height: VaayuSpacing.sm),

            // Action Selection Tabs
            Row(
              children: [
                _buildActionTab(OperatorActionType.redispatch, 'Re-Dispatch', colors),
                const SizedBox(width: 6),
                _buildActionTab(OperatorActionType.assignDriver, 'Assign Driver', colors),
                const SizedBox(width: 6),
                _buildActionTab(OperatorActionType.cancelOverride, 'Cancel', colors),
              ],
            ),
            const SizedBox(height: VaayuSpacing.sm),

            Text(
              _inputLabel,
              style: TextStyle(color: colors.textSecondary, fontSize: 11),
            ),
            const SizedBox(height: 4),
            TextField(
              key: const Key('operator_input_field'),
              controller: _inputController,
              style: TextStyle(color: colors.textPrimary, fontSize: 13),
              decoration: InputDecoration(
                filled: true,
                fillColor: colors.surface,
                contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(VaayuRadius.sm),
                  borderSide: BorderSide(color: colors.border),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(VaayuRadius.sm),
                  borderSide: BorderSide(color: colors.border),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(VaayuRadius.sm),
                  borderSide: BorderSide(color: colors.secondary),
                ),
              ),
            ),

            if (_errorMessage != null) ...[
              const SizedBox(height: 6),
              Text(
                _errorMessage!,
                style: TextStyle(color: colors.danger, fontSize: 11),
              ),
            ],

            const SizedBox(height: VaayuSpacing.md),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  style: TextButton.styleFrom(
                    minimumSize: const Size(48, 48),
                    tapTargetSize: MaterialTapTargetSize.padded,
                  ),
                  onPressed: _isSubmitting ? null : () => Navigator.of(context).pop(false),
                  child: Text(
                    'DISMISS',
                    style: TextStyle(color: colors.textSecondary, fontSize: 11),
                  ),
                ),
                const SizedBox(width: 8),
                VaayuButton(
                  key: const Key('btn_confirm_operator_command'),
                  label: _confirmButtonText,
                  isFullWidth: false,
                  variant: _selectedAction == OperatorActionType.cancelOverride
                      ? VaayuButtonVariant.danger
                      : VaayuButtonVariant.primary,
                  isLoading: _isSubmitting,
                  onPressed: _handleSubmit,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildActionTab(OperatorActionType type, String label, VaayuColors colors) {
    final isSelected = _selectedAction == type;
    return Expanded(
      child: GestureDetector(
        key: Key('action_tab_${type.name}'),
        onTap: () {
          setState(() {
            _selectedAction = type;
            _errorMessage = null;
            if (type == OperatorActionType.assignDriver) {
              _inputController.clear();
            } else if (type == OperatorActionType.redispatch) {
              _inputController.text = 'Operator manual re-dispatch';
            } else {
              _inputController.text = 'Operator safety override';
            }
          });
        },
        child: Container(
          constraints: const BoxConstraints(minHeight: 48.0),
          padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: isSelected ? colors.primary.withValues(alpha: 0.15) : colors.surface,
            borderRadius: BorderRadius.circular(VaayuRadius.sm),
            border: Border.all(
              color: isSelected ? colors.primary : colors.border,
            ),
          ),
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: isSelected ? colors.primary : colors.textSecondary,
              fontSize: 10,
              fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
            ),
          ),
        ),
      ),
    );
  }

  String get _inputLabel {
    switch (_selectedAction) {
      case OperatorActionType.assignDriver:
        return 'Target Driver ID:';
      case OperatorActionType.redispatch:
        return 'Re-Dispatch Reason:';
      case OperatorActionType.cancelOverride:
        return 'Cancellation Override Reason:';
    }
  }

  String get _confirmButtonText {
    switch (_selectedAction) {
      case OperatorActionType.assignDriver:
        return 'CONFIRM ASSIGN';
      case OperatorActionType.redispatch:
        return 'EXECUTE RE-DISPATCH';
      case OperatorActionType.cancelOverride:
        return 'CONFIRM CANCEL';
    }
  }
}
