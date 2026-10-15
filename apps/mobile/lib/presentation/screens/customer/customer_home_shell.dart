/// Pure presentation contract shell for Customer Home & Booking UI.
library customer_home_shell;

import '../../state/customer_trip_controller.dart';
import '../../state/view_state.dart';
import '../../../domain/customer/customer_models.dart';
import '../../../core/projection/local_trip_projection.dart';

class CustomerHomeViewModel {
  final CustomerTripController _controller;

  CustomerHomeViewModel({required CustomerTripController controller}) : _controller = controller;

  ViewState<FareEstimateResult> get fareEstimateState => _controller.estimateState;
  ViewState<LocalTripProjection> get activeTripState => _controller.activeTripState;

  Future<void> onCalculateFareClicked({
    required double pickupLat,
    required double pickupLng,
    required double dropLat,
    required double dropLng,
    String? vehicleId,
  }) {
    return _controller.requestEstimate(TripEstimateRequest(
      pickupLat: pickupLat,
      pickupLng: pickupLng,
      dropLat: dropLat,
      dropLng: dropLng,
      vehicleId: vehicleId,
    ));
  }

  Future<bool> onConfirmBookingClicked({
    required String idempotencyKey,
    required double pickupLat,
    required double pickupLng,
    required String pickupAddress,
    required double dropLat,
    required double dropLng,
    required String dropAddress,
    required String vehicleId,
  }) {
    return _controller.bookTrip(CreateBookingRequest(
      idempotencyKey: idempotencyKey,
      pickupLat: pickupLat,
      pickupLng: pickupLng,
      pickupAddress: pickupAddress,
      dropLat: dropLat,
      dropLng: dropLng,
      dropAddress: dropAddress,
      vehicleId: vehicleId,
    ));
  }

  Future<bool> onCancelTripClicked(String reason) {
    return _controller.cancelActiveTrip(reason);
  }
}
