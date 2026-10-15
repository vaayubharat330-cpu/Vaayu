/// Pure presentation contract shell for Driver Dashboard & Active Delivery UI.
library driver_dashboard_shell;

import '../../state/driver_partner_controller.dart';
import '../../state/view_state.dart';
import '../../../domain/driver/driver_models.dart';
import '../../../core/projection/local_trip_projection.dart';

class DriverDashboardViewModel {
  final DriverPartnerController _controller;

  DriverDashboardViewModel({required DriverPartnerController controller}) : _controller = controller;

  ViewState<DriverProfile> get profileState => _controller.profileState;
  ViewState<List<DriverOffer>> get offersState => _controller.offersState;
  ViewState<LocalTripProjection> get activeDeliveryState => _controller.activeDeliveryState;

  Future<void> onRefreshDashboard(String driverId) async {
    await Future.wait([
      _controller.loadProfile(driverId: driverId),
      _controller.loadOffers(driverId: driverId),
    ]);
  }

  Future<bool> onAcceptOfferClicked(String orderId) {
    return _controller.acceptOffer(orderId);
  }

  Future<bool> onStartArrivingClicked() {
    return _controller.advanceState(action: 'start-arriving');
  }

  Future<bool> onArrivedPickupClicked({Map<String, dynamic>? metadata}) {
    return _controller.advanceState(action: 'arrived-pickup', metadata: metadata);
  }

  Future<bool> onConfirmPickupClicked(String otp) {
    return _controller.advanceState(action: 'confirm-pickup', otp: otp);
  }

  Future<bool> onStartTransitClicked() {
    return _controller.advanceState(action: 'start-transit');
  }

  Future<bool> onArrivedDropoffClicked({Map<String, dynamic>? metadata}) {
    return _controller.advanceState(action: 'arrived-dropoff', metadata: metadata);
  }

  Future<bool> onCompleteTripClicked(String otp, {Map<String, dynamic>? proof}) {
    return _controller.advanceState(action: 'complete', otp: otp, proof: proof);
  }

  Future<bool> onToggleDutyClicked(String status, {String? driverId}) {
    return _controller.setDutyStatus(status, driverId: driverId);
  }
}
