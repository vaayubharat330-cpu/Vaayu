/// Driver Partner Controller: manages UI view state for driver dashboard, offers, and active deliveries.
library driver_partner_controller;

import 'dart:async';
import '../../core/network/api_client.dart';
import '../../core/projection/local_trip_projection.dart';
import '../../core/projection/projection_store.dart';
import '../../domain/driver/driver_models.dart';
import '../../domain/driver/driver_partner_service.dart';
import 'view_state.dart';

class DriverPartnerController {
  final DriverPartnerService _driverService;
  final LocalTripProjectionStore _projectionStore;
  ViewState<DriverProfile> _profileState = ViewState.initial();
  ViewState<List<DriverOffer>> _offersState = ViewState.initial();
  ViewState<LocalTripProjection> _activeDeliveryState = ViewState.initial();
  final _profileStreamController = StreamController<ViewState<DriverProfile>>.broadcast();
  final _offersStreamController = StreamController<ViewState<List<DriverOffer>>>.broadcast();
  final _activeDeliveryStreamController = StreamController<ViewState<LocalTripProjection>>.broadcast();
  StreamSubscription? _projectionSubscription;
  String? _currentActiveOrderId;

  DriverPartnerController({required DriverPartnerService driverService, required LocalTripProjectionStore projectionStore}) : _driverService = driverService, _projectionStore = projectionStore {
    _projectionSubscription = _projectionStore.projectionsStream.listen(_onProjectionUpdated);
  }

  ApiClient get apiClient => _driverService.apiClient;
  ViewState<DriverProfile> get profileState => _profileState;
  ViewState<List<DriverOffer>> get offersState => _offersState;
  ViewState<LocalTripProjection> get activeDeliveryState => _activeDeliveryState;
  String? get currentActiveOrderId => _currentActiveOrderId;
  bool get isOnline => _profileState.data?.status == 'ONLINE';
  Stream<ViewState<DriverProfile>> get profileStream => _profileStreamController.stream;
  Stream<ViewState<List<DriverOffer>>> get offersStream => _offersStreamController.stream;
  Stream<ViewState<LocalTripProjection>> get activeDeliveryStream => _activeDeliveryStreamController.stream;

  void _onProjectionUpdated(LocalTripProjection projection) {
    if (_currentActiveOrderId == null || projection.tripId == _currentActiveOrderId) {
      _currentActiveOrderId = projection.tripId;
      _activeDeliveryState = ViewState.success(projection);
      _activeDeliveryStreamController.add(_activeDeliveryState);
    }
  }

  Future<bool> setDutyStatus(String status, {String? driverId}) async {
    try {
      final success = await _driverService.updateDutyStatus(status: status, driverId: driverId);
      if (success) {
        if (_profileState.data != null) {
          _profileState = ViewState.success(_profileState.data!.copyWith(status: status));
          _profileStreamController.add(_profileState);
        } else {
          await loadProfile(driverId: driverId);
        }
      }
      return success;
    } catch (_) { return false; }
  }

  Future<void> loadProfile({String? driverId}) async {
    _profileState = ViewState.loading(_profileState.data); _profileStreamController.add(_profileState);
    try { _profileState = ViewState.success(await _driverService.getProfile(driverId: driverId)); }
    catch (e) { _profileState = ViewState.failure(e.toString(), _profileState.data); }
    _profileStreamController.add(_profileState);
  }

  Future<void> loadOffers({String? driverId}) async {
    _offersState = ViewState.loading(_offersState.data); _offersStreamController.add(_offersState);
    try { _offersState = ViewState.success(await _driverService.getOffers(driverId: driverId)); }
    catch (e) { _offersState = ViewState.failure(e.toString(), _offersState.data); }
    _offersStreamController.add(_offersState);
  }

  void declineOffer(String orderId) {
    if (_offersState.data == null) return;
    _offersState = ViewState.success(_offersState.data!.where((o) => o.orderId != orderId).toList());
    _offersStreamController.add(_offersState);
  }

  Future<bool> acceptOffer(String orderId) async {
    _activeDeliveryState = ViewState.loading(_activeDeliveryState.data); _activeDeliveryStreamController.add(_activeDeliveryState);
    try {
      await _driverService.acceptOffer(orderId);
      _currentActiveOrderId = orderId;
      if (_offersState.data != null) {
        _offersState = ViewState.success(_offersState.data!.where((o) => o.orderId != orderId).toList());
        _offersStreamController.add(_offersState);
      }
      final proj = _projectionStore.getProjection(orderId);
      if (proj != null) {
        _activeDeliveryState = ViewState.success(proj);
      } else {
        final fallback = LocalTripProjection(tripId: orderId, status: 'DRIVER_ACCEPTED', version: 2, pickupLat: 0, pickupLng: 0, dropLat: 0, dropLng: 0, totalFare: 0, updatedAt: DateTime.now());
        _projectionStore.applyAuthoritativeSnapshot(fallback);
        _activeDeliveryState = ViewState.success(fallback);
      }
      _activeDeliveryStreamController.add(_activeDeliveryState);
      return true;
    } catch (e) {
      _activeDeliveryState = ViewState.failure(e.toString(), _activeDeliveryState.data); _activeDeliveryStreamController.add(_activeDeliveryState); return false;
    }
  }

  Future<bool> advanceState({required String action, String? otp, Map<String, dynamic>? proof, Map<String, dynamic>? metadata}) async {
    if (_currentActiveOrderId == null) return false;
    _activeDeliveryState = ViewState.loading(_activeDeliveryState.data); _activeDeliveryStreamController.add(_activeDeliveryState);
    try {
      await _driverService.submitTransition(orderId: _currentActiveOrderId!, action: action, otp: otp, proof: proof, metadata: metadata);
      final proj = _projectionStore.getProjection(_currentActiveOrderId!);
      if (proj != null) { _activeDeliveryState = ViewState.success(proj); _activeDeliveryStreamController.add(_activeDeliveryState); }
      return true;
    } catch (e) {
      _activeDeliveryState = ViewState.failure(e.toString(), _activeDeliveryState.data); _activeDeliveryStreamController.add(_activeDeliveryState); return false;
    }
  }

  void clearActiveDelivery() { _currentActiveOrderId = null; _activeDeliveryState = ViewState.initial(); _activeDeliveryStreamController.add(_activeDeliveryState); }

  void dispose() { _projectionSubscription?.cancel(); _profileStreamController.close(); _offersStreamController.close(); _activeDeliveryStreamController.close(); }
}
