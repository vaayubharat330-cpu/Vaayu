import 'dart:async';
import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../../domain/driver/driver_models.dart';
import '../../common/widgets/metric_chip.dart';
import '../../common/widgets/vaayu_button.dart';
import '../../common/widgets/vaayu_card.dart';

/// Incoming Dispatch Offer Sheet.
///
/// Displays dispatched ride offer with:
/// - Authoritative fare earnings & trip distance
/// - Circular countdown timer synced to server expiration timestamp
/// - Realtime route origin & destination waypoints
/// - One-tap Accept and Decline actions
class DriverIncomingOfferSheet extends StatefulWidget {
  final DriverOffer offer;
  final VoidCallback onAccept;
  final VoidCallback onDecline;
  final bool isAccepting;
  final Duration serverClockOffset;
  final int? initialRemainingSeconds;

  final bool enableTimer;

  const DriverIncomingOfferSheet({
    super.key,
    required this.offer,
    required this.onAccept,
    required this.onDecline,
    this.isAccepting = false,
    this.serverClockOffset = Duration.zero,
    this.initialRemainingSeconds,
    this.enableTimer = true,
  });

  @override
  State<DriverIncomingOfferSheet> createState() => _DriverIncomingOfferSheetState();
}

class _DriverIncomingOfferSheetState extends State<DriverIncomingOfferSheet> {
  Timer? _countdownTimer;
  late int _remainingSeconds;
  final int _totalDurationSeconds = 30;

  @override
  void initState() {
    super.initState();
    _remainingSeconds = widget.initialRemainingSeconds ??
        widget.offer.remainingSeconds(widget.serverClockOffset);
    if (_remainingSeconds <= 0 && widget.initialRemainingSeconds == null) {
      _remainingSeconds = _totalDurationSeconds;
    }
    if (_remainingSeconds > 0) {
      _startTimer();
    }
  }

  @override
  void didUpdateWidget(covariant DriverIncomingOfferSheet oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.offer.orderId != widget.offer.orderId ||
        oldWidget.initialRemainingSeconds != widget.initialRemainingSeconds) {
      _remainingSeconds = widget.initialRemainingSeconds ??
          widget.offer.remainingSeconds(widget.serverClockOffset);
      _countdownTimer?.cancel();
      if (_remainingSeconds > 0) {
        _startTimer();
      }
    }
  }

  void _startTimer() {
    if (!widget.enableTimer) return;
    _countdownTimer?.cancel();
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return;
      setState(() {
        if (_remainingSeconds > 0) {
          _remainingSeconds--;
        } else {
          _countdownTimer?.cancel();
        }
      });
    });
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);
    final isExpired = _remainingSeconds <= 0;
    final progress = (_remainingSeconds / _totalDurationSeconds).clamp(0.0, 1.0);

    return VaayuCard(
      elevation: VaayuElevation.high,
      backgroundColor: colors.surfaceElevated,
      borderColor: isExpired
          ? colors.border
          : colors.primary.withValues(alpha: 0.6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 1. Header with Circular Expiration Timer
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: isExpired
                          ? colors.surface
                          : colors.primary.withValues(alpha: 0.15),
                      borderRadius: VaayuRadius.smBorder,
                    ),
                    child: Text(
                      isExpired ? 'OFFER EXPIRED' : 'NEW RIDE OFFER',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.0,
                        color: isExpired ? colors.textTertiary : colors.primary,
                      ),
                    ),
                  ),
                  const SizedBox(width: VaayuSpacing.xs),
                  MetricChip(
                    icon: Icons.confirmation_number_outlined,
                    value: widget.offer.orderId.length > 8
                        ? '...${widget.offer.orderId.substring(widget.offer.orderId.length - 6)}'
                        : widget.offer.orderId,
                  ),
                ],
              ),
              // Circular Countdown Ring
              SizedBox(
                width: 38,
                height: 38,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    TweenAnimationBuilder<double>(
                      duration: MediaQuery.disableAnimationsOf(context) || !widget.enableTimer
                          ? Duration.zero
                          : const Duration(seconds: 1),
                      curve: Curves.linear,
                      tween: Tween<double>(begin: progress, end: progress),
                      builder: (context, animatedProgress, child) {
                        return CircularProgressIndicator(
                          value: animatedProgress,
                          strokeWidth: 3,
                          backgroundColor: colors.surface,
                          valueColor: AlwaysStoppedAnimation<Color>(
                            _remainingSeconds > 10 ? colors.primary : colors.danger,
                          ),
                        );
                      },
                    ),
                    Text(
                      '${_remainingSeconds}s',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w800,
                        color: _remainingSeconds > 10
                            ? colors.textPrimary
                            : colors.danger,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),

          const SizedBox(height: VaayuSpacing.md),

          // 2. Earnings and Distance Row
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                '₹${widget.offer.estimatedFare.toStringAsFixed(2)}',
                style: TextStyle(
                  fontSize: 28,
                  fontWeight: FontWeight.w900,
                  color: colors.primary,
                ),
              ),
              const SizedBox(width: VaayuSpacing.sm),
              Text(
                'Guaranteed Net Fare',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: colors.textSecondary,
                ),
              ),
              const Spacer(),
              MetricChip(
                icon: Icons.route,
                value: '${widget.offer.distanceKm.toStringAsFixed(1)} km',
                accentColor: colors.secondary,
              ),
            ],
          ),

          const SizedBox(height: VaayuSpacing.md),
          const Divider(),
          const SizedBox(height: VaayuSpacing.sm),

          // 3. Waypoint Route Timeline
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Column(
                children: [
                  Icon(Icons.trip_origin, color: colors.primary, size: 18),
                  Container(
                    width: 2,
                    height: 28,
                    color: colors.border,
                  ),
                  Icon(Icons.location_on, color: colors.secondary, size: 18),
                ],
              ),
              const SizedBox(width: VaayuSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'PICKUP',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                        color: colors.textTertiary,
                      ),
                    ),
                    Text(
                      widget.offer.pickupAddress.isNotEmpty
                          ? widget.offer.pickupAddress
                          : 'Pickup Point (${widget.offer.pickupLat.toStringAsFixed(4)}, ${widget.offer.pickupLng.toStringAsFixed(4)})',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: colors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 14),
                    Text(
                      'DESTINATION',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.8,
                        color: colors.textTertiary,
                      ),
                    ),
                    Text(
                      widget.offer.dropAddress.isNotEmpty
                          ? widget.offer.dropAddress
                          : 'Dropoff Point (${widget.offer.dropLat.toStringAsFixed(4)}, ${widget.offer.dropLng.toStringAsFixed(4)})',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: colors.textPrimary,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),

          const SizedBox(height: VaayuSpacing.lg),

          // 4. Action Buttons (Accept / Decline)
          Row(
            children: [
              Expanded(
                flex: 1,
                child: VaayuButton(
                  key: const Key('btn_offer_decline'),
                  label: 'Decline',
                  variant: VaayuButtonVariant.outlined,
                  onPressed: isExpired ? null : widget.onDecline,
                ),
              ),
              const SizedBox(width: VaayuSpacing.md),
              Expanded(
                flex: 2,
                child: VaayuButton(
                  key: const Key('btn_offer_accept'),
                  label: isExpired ? 'EXPIRED' : 'ACCEPT RIDE',
                  variant: VaayuButtonVariant.primary,
                  isLoading: widget.isAccepting,
                  onPressed: isExpired ? null : widget.onAccept,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
