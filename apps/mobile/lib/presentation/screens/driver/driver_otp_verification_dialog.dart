import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../common/widgets/vaayu_button.dart';

/// Driver Customer OTP Verification Dialog.
///
/// Prompts the driver for the authoritative 4-digit customer PIN to
/// unlock trip state transitions (e.g., `confirm-pickup` or `complete`).
class DriverOtpVerificationDialog extends StatefulWidget {
  final String title;
  final String subtitle;
  final String actionLabel;
  final Future<bool> Function(String otp) onVerify;

  const DriverOtpVerificationDialog({
    super.key,
    this.title = 'Verify Customer OTP',
    this.subtitle = 'Ask the rider for their 4-digit start PIN.',
    this.actionLabel = 'Verify & Start Trip',
    required this.onVerify,
  });

  static Future<bool?> show(
    BuildContext context, {
    String title = 'Verify Customer OTP',
    String subtitle = 'Ask the rider for their 4-digit start PIN.',
    String actionLabel = 'Verify & Start Trip',
    required Future<bool> Function(String otp) onVerify,
  }) {
    final disableAnimations = MediaQuery.disableAnimationsOf(context);
    return showGeneralDialog<bool>(
      context: context,
      barrierDismissible: false,
      barrierLabel: 'DriverOtpVerificationDialog',
      barrierColor: Colors.black54,
      transitionDuration: disableAnimations ? Duration.zero : const Duration(milliseconds: 250),
      pageBuilder: (ctx, anim1, anim2) => DriverOtpVerificationDialog(
        title: title,
        subtitle: subtitle,
        actionLabel: actionLabel,
        onVerify: onVerify,
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
  State<DriverOtpVerificationDialog> createState() => _DriverOtpVerificationDialogState();
}

class _DriverOtpVerificationDialogState extends State<DriverOtpVerificationDialog> {
  final TextEditingController _otpController = TextEditingController();
  bool _isSubmitting = false;
  String? _errorMessage;

  @override
  void dispose() {
    _otpController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final otp = _otpController.text.trim();
    if (otp.length != 4 || int.tryParse(otp) == null) {
      setState(() {
        _errorMessage = 'Please enter a valid 4-digit numeric PIN';
      });
      return;
    }

    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    try {
      final success = await widget.onVerify(otp);
      if (!mounted) return;
      if (success) {
        Navigator.of(context).pop(true);
      } else {
        setState(() {
          _isSubmitting = false;
          _errorMessage = 'Incorrect PIN. Please re-check with customer.';
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isSubmitting = false;
        _errorMessage = 'Verification error: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);

    return Dialog(
      backgroundColor: colors.surfaceElevated,
      shape: const RoundedRectangleBorder(borderRadius: VaayuRadius.lgBorder),
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(VaayuSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // 1. Icon & Title
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: colors.primary.withValues(alpha: 0.15),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(Icons.pin, color: colors.primary, size: 24),
                ),
                const SizedBox(width: VaayuSpacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        widget.title,
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w800,
                          color: colors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        widget.subtitle,
                        style: TextStyle(
                          fontSize: 12,
                          color: colors.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),

            const SizedBox(height: VaayuSpacing.lg),

            // 2. 4-digit PIN Input Field
            TextField(
              key: const Key('input_otp_pin'),
              controller: _otpController,
              keyboardType: TextInputType.number,
              maxLength: 4,
              textAlign: TextAlign.center,
              autofocus: true,
              style: TextStyle(
                fontSize: 32,
                fontWeight: FontWeight.w900,
                letterSpacing: 16,
                color: colors.primary,
              ),
              decoration: InputDecoration(
                counterText: '',
                hintText: '••••',
                hintStyle: TextStyle(
                  fontSize: 32,
                  letterSpacing: 16,
                  color: colors.textTertiary,
                ),
                filled: true,
                fillColor: colors.surface,
                contentPadding: const EdgeInsets.symmetric(vertical: 16),
                border: OutlineInputBorder(
                  borderRadius: VaayuRadius.mdBorder,
                  borderSide: BorderSide(color: colors.border),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: VaayuRadius.mdBorder,
                  borderSide: BorderSide(color: colors.primary, width: 2),
                ),
              ),
              onSubmitted: (_) => _submit(),
            ),

            // 3. Error Feedback
            if (_errorMessage != null) ...[
              const SizedBox(height: VaayuSpacing.sm),
              Text(
                _errorMessage!,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: colors.danger,
                ),
              ),
            ],

            const SizedBox(height: VaayuSpacing.lg),

            // 4. Action Buttons
            Row(
              children: [
                Expanded(
                  child: VaayuButton(
                    key: const Key('btn_otp_cancel'),
                    label: 'Cancel',
                    variant: VaayuButtonVariant.outlined,
                    onPressed: _isSubmitting ? null : () => Navigator.of(context).pop(false),
                  ),
                ),
                const SizedBox(width: VaayuSpacing.md),
                Expanded(
                  child: VaayuButton(
                    key: const Key('btn_otp_confirm'),
                    label: widget.actionLabel,
                    variant: VaayuButtonVariant.primary,
                    isLoading: _isSubmitting,
                    onPressed: _submit,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
