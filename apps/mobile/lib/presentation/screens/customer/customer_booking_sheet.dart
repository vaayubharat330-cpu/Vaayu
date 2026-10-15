import 'dart:math';
import 'package:flutter/material.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';
import '../../../domain/customer/customer_models.dart';
import '../../common/widgets/vaayu_button.dart';
import '../../common/widgets/vaayu_card.dart';
import '../../common/widgets/metric_chip.dart';
import '../../state/customer_trip_controller.dart';
import '../../state/view_state.dart';
import 'vehicle_tier_selector.dart';
import 'fare_breakdown_sheet.dart';

class AddressPreset {
  final String title;
  final String address;
  final double lat;
  final double lng;

  const AddressPreset({
    required this.title,
    required this.address,
    required this.lat,
    required this.lng,
  });
}

/// Customer Ride Booking Sheet.
/// Solicits authoritative estimates and submits signed, idempotent booking intents.
class CustomerBookingSheet extends StatefulWidget {
  final CustomerTripController controller;

  const CustomerBookingSheet({
    super.key,
    required this.controller,
  });

  @override
  State<CustomerBookingSheet> createState() => _CustomerBookingSheetState();
}

class _CustomerBookingSheetState extends State<CustomerBookingSheet> {
  static const AddressPreset defaultPickup = AddressPreset(
    title: 'Charminar',
    address: 'Charminar, Old City, Hyderabad',
    lat: 17.385044,
    lng: 78.486671,
  );

  static const List<AddressPreset> popularDestinations = [
    AddressPreset(
      title: 'Hitec City',
      address: 'Hitec City, Madhapur, Hyderabad',
      lat: 17.4435,
      lng: 78.3772,
    ),
    AddressPreset(
      title: 'Gachibowli',
      address: 'Gachibowli Stadium Road, Hyderabad',
      lat: 17.4401,
      lng: 78.3489,
    ),
    AddressPreset(
      title: 'Secunderabad',
      address: 'Secunderabad Railway Station, Hyderabad',
      lat: 17.4399,
      lng: 78.4983,
    ),
    AddressPreset(
      title: 'RGIA Airport',
      address: 'Rajiv Gandhi International Airport, Shamshabad',
      lat: 17.2403,
      lng: 78.4294,
    ),
  ];

  late AddressPreset _pickup;
  late AddressPreset _dropoff;
  String _selectedVehicleId = 'v_2w';
  bool _isBooking = false;

  @override
  void initState() {
    super.initState();
    _pickup = defaultPickup;
    _dropoff = popularDestinations.first;
    _fetchEstimate();
  }

  void _fetchEstimate() {
    widget.controller.requestEstimate(TripEstimateRequest(
      pickupLat: _pickup.lat,
      pickupLng: _pickup.lng,
      dropLat: _dropoff.lat,
      dropLng: _dropoff.lng,
      vehicleId: _selectedVehicleId,
    ));
  }

  void _onVehicleSelected(String vehicleId) {
    setState(() {
      _selectedVehicleId = vehicleId;
    });
    _fetchEstimate();
  }

  void _onDropoffSelected(AddressPreset preset) {
    setState(() {
      _dropoff = preset;
    });
    _fetchEstimate();
  }

  Future<void> _handleBookRide() async {
    setState(() {
      _isBooking = true;
    });

    // Generate client-side UUID intent for server-enforced idempotency
    final random = Random();
    final randomHex = List.generate(16, (_) => random.nextInt(16).toRadixString(16)).join();
    final idempotencyKey = 'idem_${DateTime.now().millisecondsSinceEpoch}_$randomHex';

    final request = CreateBookingRequest(
      idempotencyKey: idempotencyKey,
      pickupLat: _pickup.lat,
      pickupLng: _pickup.lng,
      pickupAddress: _pickup.address,
      dropLat: _dropoff.lat,
      dropLng: _dropoff.lng,
      dropAddress: _dropoff.address,
      vehicleId: _selectedVehicleId,
    );

    final success = await widget.controller.bookTrip(request);
    if (mounted) {
      setState(() {
        _isBooking = false;
      });
      if (!success) {
        final errorMsg = widget.controller.activeTripState.errorMessage ?? 'Booking failed';
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(errorMsg),
            backgroundColor: Colors.red.shade800,
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);

    return StreamBuilder<ViewState<FareEstimateResult>>(
      stream: widget.controller.estimateStream,
      initialData: widget.controller.estimateState,
      builder: (context, snapshot) {
        final estimateState = snapshot.data ?? widget.controller.estimateState;
        final estimate = estimateState.data;
        final isLoadingEstimate = estimateState.isLoading;

        return SingleChildScrollView(
          padding: const EdgeInsets.all(VaayuSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // 1. Pickup & Destination Spatial Route Card
              VaayuCard(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Column(
                      children: [
                        const SizedBox(height: 2),
                        Icon(Icons.trip_origin, color: colors.primary, size: 18),
                        Container(
                          width: 2,
                          height: 34,
                          color: colors.border,
                        ),
                        Icon(Icons.location_on, color: colors.danger, size: 18),
                      ],
                    ),
                    const SizedBox(width: VaayuSpacing.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Pickup Location',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: colors.textSecondary,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            _pickup.address,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                              color: colors.textPrimary,
                            ),
                          ),
                          const SizedBox(height: VaayuSpacing.sm * 1.5),
                          Text(
                            'Destination',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: colors.textSecondary,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            _dropoff.address,
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
              ),

              const SizedBox(height: VaayuSpacing.md),

              // 2. Quick-Pick Destination Pills
              Text(
                'Quick Destinations',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: colors.textSecondary),
              ),
              const SizedBox(height: VaayuSpacing.xs),
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: popularDestinations.map((preset) {
                    final isSelected = preset.title == _dropoff.title;
                    return Padding(
                      padding: const EdgeInsets.only(right: VaayuSpacing.sm),
                      child: MetricChip(
                        icon: Icons.history,
                        value: preset.title,
                        accentColor: isSelected ? colors.primary : null,
                        onTap: () => _onDropoffSelected(preset),
                      ),
                    );
                  }).toList(),
                ),
              ),

              const SizedBox(height: VaayuSpacing.lg),

              // 3. Vehicle Tier Selection
              VehicleTierSelector(
                selectedVehicleId: _selectedVehicleId,
                onTierSelected: _onVehicleSelected,
                estimatedFares: estimate?.estimatedFare != null
                    ? {_selectedVehicleId: estimate!.estimatedFare!}
                    : null,
              ),

              const SizedBox(height: VaayuSpacing.md),

              // 4. Server Estimate Summary Card
              if (estimate != null && estimate.success)
                VaayuCard(
                  backgroundColor: colors.surface,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Text(
                                  '₹${estimate.estimatedFare?.toStringAsFixed(0) ?? "--"}',
                                  style: TextStyle(
                                    fontSize: 22,
                                    fontWeight: FontWeight.w900,
                                    color: colors.primary,
                                  ),
                                ),
                                const SizedBox(width: VaayuSpacing.sm),
                                Text(
                                  'Locked Fare',
                                  style: TextStyle(fontSize: 12, color: colors.textSecondary),
                                ),
                              ],
                            ),
                            const SizedBox(height: 2),
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    '${estimate.distanceKm?.toStringAsFixed(1) ?? "--"} km • ~${estimate.durationMins?.toStringAsFixed(0) ?? "--"} mins',
                                    style: TextStyle(fontSize: 12, color: colors.textSecondary),
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                      ConstrainedBox(
                        constraints: const BoxConstraints(minHeight: 48.0, minWidth: 48.0),
                        child: Center(
                          widthFactor: 1.0,
                          heightFactor: 1.0,
                          child: InkWell(
                            onTap: () => FareBreakdownSheet.show(context, estimate),
                            borderRadius: VaayuRadius.pillBorder,
                            child: Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(
                                    'Breakdown',
                                    style: TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w600,
                                      color: colors.secondary,
                                    ),
                                  ),
                                  Icon(Icons.chevron_right, size: 18, color: colors.secondary),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                )
              else if (isLoadingEstimate)
                Container(
                  height: 60,
                  alignment: Alignment.center,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2, color: colors.primary),
                      ),
                      const SizedBox(width: VaayuSpacing.sm),
                      Text(
                        'Calculating Authoritative Fare...',
                        style: TextStyle(fontSize: 13, color: colors.textSecondary),
                      ),
                    ],
                  ),
                ),

              const SizedBox(height: VaayuSpacing.lg),

              // 5. Booking Action Button
              VaayuButton(
                label: 'Confirm & Dispatch Ride',
                leadingIcon: Icons.electric_bolt,
                isLoading: _isBooking,
                onPressed: _handleBookRide,
              ),
            ],
          ),
        );
      },
    );
  }
}
