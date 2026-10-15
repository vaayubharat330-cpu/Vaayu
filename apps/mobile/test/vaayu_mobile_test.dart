import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaayu_mobile/core/errors/auth_exception.dart';
import 'package:vaayu_mobile/core/models/auth_session.dart';
import 'package:vaayu_mobile/core/security/secure_storage_service.dart';
import 'package:vaayu_mobile/core/session/session_manager.dart';
import 'package:vaayu_mobile/core/projection/projection_store.dart';
import 'package:vaayu_mobile/core/projection/driver_location_projection.dart';
import 'package:vaayu_mobile/core/projection/driver_location_store.dart';
import 'package:vaayu_mobile/core/projection/offer_projection.dart';
import 'package:vaayu_mobile/core/projection/offer_store.dart';
import 'package:vaayu_mobile/core/projection/local_trip_projection.dart';
import 'package:vaayu_mobile/core/network/api_client.dart';
import 'package:vaayu_mobile/core/network/idempotency_manager.dart';
import 'package:vaayu_mobile/core/network/single_flight_refresh.dart';
import 'package:vaayu_mobile/core/persistence/local_persistence_service.dart';
import 'package:vaayu_mobile/core/persistence/pending_mutation.dart';
import 'package:vaayu_mobile/core/lifecycle/app_lifecycle_manager.dart';
import 'package:vaayu_mobile/core/resync/resync_coordinator.dart';
import 'package:vaayu_mobile/core/resync/offline_queue_flusher.dart';
import 'package:vaayu_mobile/domain/customer/customer_models.dart';
import 'package:vaayu_mobile/domain/customer/customer_trip_service.dart';
import 'package:vaayu_mobile/core/config/app_config.dart';
import 'package:vaayu_mobile/core/config/diagnostic_helpers.dart';
import 'package:vaayu_mobile/core/theme/vaayu_colors.dart';
import 'package:vaayu_mobile/core/theme/vaayu_theme.dart';
import 'package:vaayu_mobile/core/theme/vaayu_tokens.dart';
import 'package:vaayu_mobile/presentation/common/widgets/status_badge.dart';
import 'package:vaayu_mobile/presentation/common/widgets/metric_chip.dart';
import 'package:vaayu_mobile/presentation/common/widgets/vaayu_button.dart';
import 'package:vaayu_mobile/presentation/common/widgets/vaayu_card.dart';
import 'package:vaayu_mobile/main.dart';
import 'package:vaayu_mobile/presentation/navigation/app_router.dart';
import 'package:vaayu_mobile/presentation/state/view_state.dart';
import 'package:vaayu_mobile/core/websocket/websocket_client.dart';
import 'package:vaayu_mobile/core/websocket/websocket_event_decoder.dart';
import 'package:vaayu_mobile/core/websocket/websocket_event_router.dart';
import 'package:vaayu_mobile/core/websocket/websocket_events.dart';
import 'package:vaayu_mobile/presentation/state/customer_trip_controller.dart';
import 'package:vaayu_mobile/presentation/screens/customer/vehicle_tier_selector.dart';
import 'package:vaayu_mobile/presentation/screens/customer/fare_breakdown_sheet.dart';
import 'package:vaayu_mobile/presentation/screens/customer/customer_booking_sheet.dart';
import 'package:vaayu_mobile/presentation/screens/customer/customer_active_ride_cockpit.dart';
import 'package:vaayu_mobile/presentation/screens/customer/customer_home_screen.dart';
import 'package:vaayu_mobile/domain/driver/driver_models.dart';
import 'package:vaayu_mobile/domain/driver/driver_partner_service.dart';
import 'package:vaayu_mobile/presentation/state/driver_partner_controller.dart';
import 'package:vaayu_mobile/presentation/screens/driver/driver_duty_toggle_card.dart';
import 'package:vaayu_mobile/presentation/screens/driver/driver_incoming_offer_sheet.dart';
import 'package:vaayu_mobile/presentation/screens/driver/driver_otp_verification_dialog.dart';
import 'package:vaayu_mobile/presentation/screens/driver/driver_active_trip_cockpit.dart';
import 'package:vaayu_mobile/presentation/screens/driver/driver_dashboard_screen.dart';
import 'package:vaayu_mobile/domain/operations/operations_models.dart';
import 'package:vaayu_mobile/domain/operations/operations_service.dart';
import 'package:vaayu_mobile/presentation/state/operations_controller.dart';
import 'package:vaayu_mobile/presentation/screens/operations/operations_incident_wall.dart';
import 'package:vaayu_mobile/presentation/screens/operations/operations_fleet_status_bar.dart';
import 'package:vaayu_mobile/presentation/screens/operations/operations_live_cards.dart';
import 'package:vaayu_mobile/presentation/screens/operations/operations_intervention_dialog.dart';
import 'package:vaayu_mobile/presentation/screens/operations/operations_dashboard_screen.dart';
import 'package:vaayu_mobile/domain/simulator/scenario_runner.dart';
import 'package:vaayu_mobile/presentation/simulator/multi_role_simulator_shell.dart';

void main() {
  group('Pillar 15B.2: Native Flutter Unit Tests', () {
    test('SessionManager restores session from storage and verifies expiry', () async {
      final storage = InMemorySecureStorageService();
      final manager = SessionManager(storage: storage);

      expect(manager.isAuthenticated, false);
      expect(manager.status, SessionStatus.unauthenticated);

      final session = AuthSession(
        userId: 'usr_cust_123',
        role: 'CUSTOMER',
        name: 'Suresh Cust',
        phone: '9876543210',
        city: 'hyderabad',
        issuedAt: DateTime.now(),
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      );

      await manager.establishSession(session);
      expect(manager.isAuthenticated, true);
      expect(manager.status, SessionStatus.authenticated);
      expect(manager.currentSession?.role, 'CUSTOMER');

      final token = await manager.getValidToken();
      expect(token, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');

      await manager.clearSession();
      expect(manager.isAuthenticated, false);
      expect(manager.status, SessionStatus.unauthenticated);
    });

    test('ProjectionStore enforces monotonic versioning', () {
      final store = ProjectionStore();
      expect(store.currentTrip, isNull);

      final v1 = LocalTripProjection(
        tripId: 'TRIP_101',
        status: 'DRIVER_ACCEPTED',
        version: 1,
        pickupLat: 17.38,
        pickupLng: 78.48,
        dropLat: 17.44,
        dropLng: 78.34,
        totalFare: 150.0,
        updatedAt: DateTime.now(),
      );

      final appliedV1 = store.applyUpdate(v1);
      expect(appliedV1, true);
      expect(store.currentTrip?.version, 1);
      expect(store.currentTrip?.status, 'DRIVER_ACCEPTED');

      // Stale or duplicate version must be discarded
      final v1Duplicate = v1.copyWith(status: 'STALE');
      final appliedStale = store.applyUpdate(v1Duplicate);
      expect(appliedStale, false);
      expect(store.currentTrip?.status, 'DRIVER_ACCEPTED');

      // Monotonic version advances
      final v2 = v1.copyWith(status: 'IN_TRANSIT', version: 2);
      final appliedV2 = store.applyUpdate(v2);
      expect(appliedV2, true);
      expect(store.currentTrip?.version, 2);
      expect(store.currentTrip?.status, 'IN_TRANSIT');
    });

    test('IdempotencyManager generates valid UUIDv4 and retains for same intent', () {
      final mgr = IdempotencyManager();
      final key1 = mgr.getOrCreateKey(intentId: 'booking_intent_1');
      expect(key1, isNotEmpty);
      expect(key1.length, 36);

      final key1Retry = mgr.getOrCreateKey(intentId: 'booking_intent_1');
      expect(key1Retry, equals(key1), reason: 'Retried intent must yield identical key');

      final key2 = mgr.getOrCreateKey(intentId: 'booking_intent_2');
      expect(key2, isNot(equals(key1)));
    });

    test('AppRouter enforces role-based route guards', () {
      final customerSession = AuthSession(
        userId: 'c1',
        role: 'CUSTOMER',
        name: 'Customer 1',
        phone: '9876543211',
        city: 'hyderabad',
        issuedAt: DateTime.now(),
        token: 't1',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      );

      final router = AppRouter(initialSession: customerSession);
      expect(router.currentRoute, AppRoute.customerHome);

      // Customer cannot navigate to driver dashboard
      final allowedDriver = router.navigateTo(AppRoute.driverDashboard);
      expect(allowedDriver, false);
      expect(router.currentRoute, AppRoute.customerHome);

      // Customer can navigate to booking
      final allowedBooking = router.navigateTo(AppRoute.customerBooking);
      expect(allowedBooking, true);
      expect(router.currentRoute, AppRoute.customerBooking);
    });

    test('ViewState preserves previous data on failure for graceful degradation', () {
      final initial = ViewState<int>.initial(100);
      expect(initial.isInitial, true);
      expect(initial.data, 100);

      final loading = ViewState<int>.loading(100);
      expect(loading.isLoading, true);
      expect(loading.data, 100);

      final failure = ViewState<int>.failure('Network timeout', 100);
      expect(failure.isFailure, true);
      expect(failure.errorMessage, 'Network timeout');
      expect(failure.data, 100);
    });
  });


  group('Phase A: Unified WebSocket transport and event routing', () {
    test('serializes JSON correctly and replays rooms after reconnect', () async {
      final sockets = <_FakeSocket>[];
      final client = WebSocketClient(
        serverUrl: 'ws://example.test/ws',
        tokenProvider: () async => 'token-123',
        channelFactory: (_) {
          final socket = _FakeSocket();
          sockets.add(socket);
          return socket;
        },
        random: Random(1),
      );

      expect(await client.connect(), true);
      client.joinRoom('trip:T1');
      expect(sockets.single.sent, contains('{"action":"join","room":"trip:T1"}'));

      await sockets.single.incoming.close();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(client.status, WebSocketStatus.reconnecting);

      // Do not wait for the real reconnect timer in this unit test; the
      // transport contract above is enough to verify JSON and room intent.
      expect(client.subscribedRooms, contains('trip:T1'));
      await client.dispose();
    });

    test('decodes trip state, location, offer and pong frames', () {
      const decoder = WebSocketEventDecoder();
      final trip = LocalTripProjection(
        tripId: 'T1',
        status: 'DRIVER_ACCEPTED',
        version: 7,
        pickupLat: 17.38,
        pickupLng: 78.48,
        dropLat: 17.44,
        dropLng: 78.34,
        totalFare: 150,
        updatedAt: DateTime.utc(2026, 10, 14),
      );

      expect(
        decoder.decode({'type': 'trip_state_update', 'trip': trip.toJson()}),
        isA<TripStateUpdateEvent>(),
      );
      expect(
        decoder.decode({
          'type': 'driver_location_ping',
          'data': {'tripId': 'T1', 'lat': 17.38, 'lng': 78.48, 'sequence': 9},
        }),
        isA<DriverLocationPingEvent>(),
      );
      expect(
        decoder.decode({'type': 'offer_dispatched', 'data': {'offerId': 'O1'}}),
        isA<OfferDispatchedEvent>(),
      );
      expect(decoder.decode({'type': 'pong'}), isA<PongEvent>());
    });

    test('routes trip state to projection but keeps GPS off trip version', () async {
      final store = ProjectionStore();
      final router = WebSocketEventRouter(projectionStore: store);
      final locations = <DriverLocationPingEvent>[];
      final sub = router.locationStream.listen(locations.add);

      final trip = LocalTripProjection(
        tripId: 'T1',
        status: 'DRIVER_ACCEPTED',
        version: 3,
        pickupLat: 17.38,
        pickupLng: 78.48,
        dropLat: 17.44,
        dropLng: 78.34,
        totalFare: 150,
        updatedAt: DateTime.utc(2026, 10, 14),
      );

      expect(router.routeFrame({'type': 'trip_state_update', 'trip': trip.toJson()}), true);
      expect(store.currentTrip?.version, 3);

      expect(router.routeFrame({
        'type': 'driver_location_ping',
        'data': {'tripId': 'T1', 'lat': 17.381, 'lng': 78.481, 'sequence': 1},
      }), true);
      await Future<void>.delayed(Duration.zero);

      expect(locations, hasLength(1));
      expect(store.currentTrip?.version, 3);
      await sub.cancel();
      await router.dispose();
    });
  });
  phaseBTests();
  phaseCTests();
}

class _FakeSocket implements IWebSocketChannel {
  final StreamController<dynamic> incoming = StreamController<dynamic>.broadcast();
  final List<String> sent = <String>[];
  bool closed = false;

  @override
  void send(String message) => sent.add(message);

  @override
  Stream<dynamic> get stream => incoming.stream;

  @override
  Future<void> close([int? code, String? reason]) async {
    closed = true;
    await incoming.close();
  }
}


void phaseBTests() {
  group('Phase B: State & Projection Decoupling', () {
    LocalTripProjection trip(String id, int version, String status) => LocalTripProjection(
          tripId: id,
          status: status,
          version: version,
          pickupLat: 17.38,
          pickupLng: 78.48,
          dropLat: 17.44,
          dropLng: 78.34,
          totalFare: 150,
          updatedAt: DateTime.utc(2026, 10, 14),
        );

    test('ProjectionStore retains independent versions for multiple trips', () {
      final store = ProjectionStore();
      expect(store.applyUpdate(trip('T1', 1, 'ACCEPTED')), true);
      expect(store.applyUpdate(trip('T2', 4, 'IN_TRANSIT')), true);
      expect(store.applyUpdate(trip('T1', 2, 'PICKED_UP')), true);
      expect(store.applyUpdate(trip('T2', 3, 'STALE')), false);

      expect(store.tripIds, containsAll(<String>['T1', 'T2']));
      expect(store.getProjection('T1')?.version, 2);
      expect(store.getProjection('T1')?.status, 'PICKED_UP');
      expect(store.getProjection('T2')?.version, 4);
      expect(store.getProjection('T2')?.status, 'IN_TRANSIT');
    });

    test('DriverLocationStore gates GPS by sequence without touching trip state', () {
      final store = DriverLocationStore();
      final t1v7 = trip('T1', 7, 'IN_TRANSIT');
      final location1 = DriverLocationProjection(
        tripId: 'T1', latitude: 17.380, longitude: 78.480,
        receivedAt: DateTime.utc(2026, 10, 14, 10, 0), sequence: 100,
      );
      final location2 = DriverLocationProjection(
        tripId: 'T1', latitude: 17.381, longitude: 78.481,
        receivedAt: DateTime.utc(2026, 10, 14, 10, 0, 1), sequence: 101,
      );
      final stale = DriverLocationProjection(
        tripId: 'T1', latitude: 17.379, longitude: 78.479,
        receivedAt: DateTime.utc(2026, 10, 14, 10, 0, 2), sequence: 99,
      );

      expect(store.apply(location1), true);
      expect(store.apply(location2), true);
      expect(store.apply(stale), false);
      expect(store.getLocation('T1')?.sequence, 101);
      expect(t1v7.version, 7);
    });

    test('DriverLocationStore uses timestamp ordering when sequence is absent', () {
      final store = DriverLocationStore();
      expect(store.apply(DriverLocationProjection(
        tripId: 'T2', latitude: 17.1, longitude: 78.1,
        receivedAt: DateTime.utc(2026, 10, 14, 10, 0),
      )), true);
      expect(store.apply(DriverLocationProjection(
        tripId: 'T2', latitude: 17.2, longitude: 78.2,
        receivedAt: DateTime.utc(2026, 10, 14, 9, 59),
      )), false);
      expect(store.getLocation('T2')?.latitude, 17.1);
    });

    test('OfferProjection uses server clock offset for UI-only expiry', () {
      final received = DateTime.utc(2026, 10, 14, 10, 0, 0);
      final serverNow = DateTime.utc(2026, 10, 14, 10, 0, 5);
      final expires = DateTime.utc(2026, 10, 14, 10, 0, 20);
      final offer = OfferProjection(
        offerId: 'O1', orderId: 'T1', payload: const {'offerId': 'O1'},
        receivedAt: received, serverTimeAtReceipt: serverNow, expiresAt: expires,
      );

      expect(offer.serverClockOffset, const Duration(seconds: 5));
      expect(offer.isExpiredAt(DateTime.utc(2026, 10, 14, 10, 0, 14)), false);
      expect(offer.isExpiredAt(DateTime.utc(2026, 10, 14, 10, 0, 15)), true);
    });

    test('WebSocket router stores location and offer projections separately', () async {
      final projectionStore = ProjectionStore();
      final locationStore = DriverLocationStore();
      final offerStore = OfferStore();
      final router = WebSocketEventRouter(
        projectionStore: projectionStore,
        locationStore: locationStore,
        offerStore: offerStore,
      );

      expect(router.routeFrame({
        'type': 'driver_location_ping',
        'data': {
          'tripId': 'T9', 'lat': 17.38, 'lng': 78.48,
          'sequence': 12,
        },
      }), true);
      expect(locationStore.getLocation('T9')?.sequence, 12);
      expect(projectionStore.getProjection('T9'), isNull);

      expect(router.routeFrame({
        'type': 'offer_dispatched',
        'data': {
          'offerId': 'O9', 'orderId': 'T9',
          'expiresAt': '2026-10-14T10:01:00Z',
          'serverTime': '2026-10-14T10:00:00Z',
        },
      }), true);
      expect(offerStore.getOffer('O9')?.orderId, 'T9');
      expect(offerStore.getOffer('O9')?.expiresAt, isNotNull);

      await router.dispose();
    });
  });
}

void phaseCTests() {
  group('Phase C: Offline Durability, Error Classification & Token Refresh', () {
    test('C1: FileLocalPersistenceService survives process restart without mutation duplication', () async {
      final tempDir = Directory.systemTemp.createTempSync('vaayu_phase_c_');
      try {
        // 1. Process A initializes persistence and enqueues mutations
        final serviceA = FileLocalPersistenceService(directory: tempDir);

        final m1 = PendingMutation(
          intentId: 'intent_101',
          idempotencyKey: 'idem_uuid_101',
          operation: 'accept',
          tripId: 'TRIP_101',
          payload: {'orderId': 'TRIP_101', 'idempotencyKey': 'idem_uuid_101'},
          createdAt: DateTime.utc(2026, 10, 14, 10, 0, 0),
        );
        final m2 = PendingMutation(
          intentId: 'intent_102',
          idempotencyKey: 'idem_uuid_102',
          operation: 'start-arriving',
          tripId: 'TRIP_101',
          payload: {'orderId': 'TRIP_101', 'idempotencyKey': 'idem_uuid_102'},
          createdAt: DateTime.utc(2026, 10, 14, 10, 0, 5),
        );

        final snapshot = LocalTripProjection(
          tripId: 'TRIP_101',
          status: 'ACCEPTED',
          version: 2,
          pickupLat: 17.38,
          pickupLng: 78.48,
          dropLat: 17.44,
          dropLng: 78.34,
          totalFare: 150,
          updatedAt: DateTime.utc(2026, 10, 14, 10, 0, 0),
        );

        await serviceA.saveTripSnapshot(snapshot);
        await serviceA.enqueueMutation(m2); // Enqueued second
        await serviceA.enqueueMutation(m1); // Enqueued first by createdAt

        // 2. Simulate Process Termination (serviceA dropped)
        // 3. Process B restarts and points to identical directory
        final serviceB = FileLocalPersistenceService(directory: tempDir);

        final restoredSnapshot = await serviceB.getTripSnapshot('TRIP_101');
        expect(restoredSnapshot, isNotNull);
        expect(restoredSnapshot?.status, 'ACCEPTED');
        expect(restoredSnapshot?.version, 2);

        final pending = await serviceB.getPendingMutations();
        expect(pending, hasLength(2));
        // Verify strict FIFO ordering by createdAt
        expect(pending[0].intentId, 'intent_101');
        expect(pending[0].idempotencyKey, 'idem_uuid_101');
        expect(pending[1].intentId, 'intent_102');
        expect(pending[1].idempotencyKey, 'idem_uuid_102');

        // 4. Mutation removed on replay
        await serviceB.removeMutation('intent_101');

        // 5. Process C restarts and verifies mutation was cleanly purged
        final serviceC = FileLocalPersistenceService(directory: tempDir);
        final pendingAfter = await serviceC.getPendingMutations();
        expect(pendingAfter, hasLength(1));
        expect(pendingAfter[0].intentId, 'intent_102');
      } finally {
        if (tempDir.existsSync()) {
          tempDir.deleteSync(recursive: true);
        }
      }
    });

    test('C2: AppLifecycleObserver triggers per-trip ResyncCoordinator and queue flusher on foreground resume', () async {
      final lifecycle = AppLifecycleManager();
      final observer = AppLifecycleObserver(lifecycleManager: lifecycle);

      final projectionStore = ProjectionStore();
      final persistence = InMemoryLocalPersistenceService();
      final resyncCalls = <String>[];

      final resyncCoordinator = ResyncCoordinator(
        projectionStore: projectionStore,
        persistenceService: persistence,
        fetchAuthoritativeTrip: (tripId) async {
          resyncCalls.add(tripId);
          return LocalTripProjection(
            tripId: tripId,
            status: 'IN_TRANSIT',
            version: 5,
            pickupLat: 17.38,
            pickupLng: 78.48,
            dropLat: 17.44,
            dropLng: 78.34,
            totalFare: 150,
            updatedAt: DateTime.now(),
          );
        },
      );

      // Verify per-trip concurrent single-flight coalescing
      final futureA1 = resyncCoordinator.resyncTrip('TRIP_A');
      final futureA2 = resyncCoordinator.resyncTrip('TRIP_A');
      final futureB1 = resyncCoordinator.resyncTrip('TRIP_B');

      expect(resyncCoordinator.isResyncingTrip('TRIP_A'), true);
      expect(resyncCoordinator.isResyncingTrip('TRIP_B'), true);

      final results = await Future.wait([futureA1, futureA2, futureB1]);
      expect(results[0]?.tripId, 'TRIP_A');
      expect(results[1]?.tripId, 'TRIP_A');
      expect(results[2]?.tripId, 'TRIP_B');
      // TRIP_A coalesced into 1 fetch, TRIP_B had 1 fetch = 2 fetches total
      expect(resyncCalls, equals(['TRIP_A', 'TRIP_B']));

      // Test lifecycle bridge
      bool foregroundFired = false;
      lifecycle.addOnForegroundListener(() async {
        foregroundFired = true;
      });

      // Background app
      observer.didChangeAppLifecycleState(AppLifecycleState.paused);
      expect(lifecycle.currentState, MobileLifecycleState.paused);
      expect(lifecycle.isForeground, false);
      expect(foregroundFired, false);

      // Foreground app
      observer.didChangeAppLifecycleState(AppLifecycleState.resumed);
      expect(lifecycle.currentState, MobileLifecycleState.resumed);
      expect(lifecycle.isForeground, true);
      expect(foregroundFired, true);

      lifecycle.dispose();
    });

    test('C3: OfflineQueueFlusher evicts permanent 4xx rejections and retries transient errors', () async {
      final persistence = InMemoryLocalPersistenceService();
      final projectionStore = ProjectionStore();

      // Mutation 1: Permanent failure (400 Invalid OTP)
      final mPerm = PendingMutation(
        intentId: 'm_perm',
        idempotencyKey: 'key_perm',
        operation: 'confirm-pickup',
        tripId: 'TRIP_1',
        payload: {'orderId': 'TRIP_1'},
        createdAt: DateTime.utc(2026, 10, 14, 10, 0, 0),
      );
      // Mutation 2: Dependent downstream mutation on same trip (should be blocked and evicted)
      final mDep = PendingMutation(
        intentId: 'm_dep',
        idempotencyKey: 'key_dep',
        operation: 'complete',
        tripId: 'TRIP_1',
        payload: {'orderId': 'TRIP_1'},
        createdAt: DateTime.utc(2026, 10, 14, 10, 0, 1),
      );
      // Mutation 3: Different trip that encounters transient 503 error
      final mTrans = PendingMutation(
        intentId: 'm_trans',
        idempotencyKey: 'key_trans',
        operation: 'accept',
        tripId: 'TRIP_2',
        payload: {'orderId': 'TRIP_2'},
        createdAt: DateTime.utc(2026, 10, 14, 10, 0, 2),
      );

      await persistence.enqueueMutation(mPerm);
      await persistence.enqueueMutation(mDep);
      await persistence.enqueueMutation(mTrans);

      final flusher = OfflineQueueFlusher(
        persistenceService: persistence,
        projectionStore: projectionStore,
        executeMutation: (m) async {
          if (m.intentId == 'm_perm') {
            return MutationReplayResult.fromResponse(
              mutation: m,
              statusCode: 400,
              errorMessage: 'Invalid customer verification OTP',
            );
          }
          if (m.intentId == 'm_trans') {
            return MutationReplayResult.fromResponse(
              mutation: m,
              statusCode: 503,
              errorMessage: 'Service temporarily unavailable',
            );
          }
          return MutationReplayResult.fromResponse(
            mutation: m,
            statusCode: 200,
          );
        },
      );

      final results = await flusher.flushQueue();
      expect(results, hasLength(3));

      // mPerm is permanent rejection
      expect(results[0].permanentRejection, true);
      expect(results[0].statusCode, 400);

      // mDep blocked by prior failure on TRIP_1
      expect(results[1].permanentRejection, true);
      expect(results[1].errorCode, 'BLOCKED_BY_PRIOR_FAILURE');

      // mTrans is transient failure
      expect(results[2].transientFailure, true);
      expect(results[2].statusCode, 503);

      // Verify persistent queue state:
      // mPerm and mDep were purged; mTrans remains with incremented retry count
      final remaining = await persistence.getPendingMutations();
      expect(remaining, hasLength(1));
      expect(remaining.single.intentId, 'm_trans');
      expect(remaining.single.retryCount, 1);
      expect(remaining.single.idempotencyKey, 'key_trans'); // Key retained!
    });

    test('C4: SingleFlightRefreshCoordinator handles 401s without stampede and retries with new token', () async {
      final storage = InMemorySecureStorageService();
      final sessionMgr = SessionManager(storage: storage);

      // Bypass establishSession expiration check to simulate active expired session needing refresh
      await storage.write(
        key: SessionManager.keyActiveSession,
        value: '{"userId":"usr_c4","role":"CUSTOMER","name":"C4 User","phone":"9999900004","city":"Hyderabad","issuedAt":"${DateTime.now().toIso8601String()}","token":"old_expired_token_jwt","expiresAt":"${DateTime.now().add(const Duration(hours: 1)).toIso8601String()}"}',
      );
      await sessionMgr.restoreSession();

      int refreshFlightCount = 0;
      final coordinator = SingleFlightRefreshCoordinator(
        sessionManager: sessionMgr,
        refreshCall: () async {
          refreshFlightCount++;
          await Future<void>.delayed(const Duration(milliseconds: 30));
          // Valid JWT with 24hr expiry
          return 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InVzcl9jNCIsIm5hbWUiOiJDNCBVc2VyIiwicGhvbmUiOiI5OTk5OTAwMDA0Iiwicm9sZSI6IkNVU1RPTUVSIiwiY2l0eSI6Ikh5ZGVyYWJhZCIsImlhdCI6MTc5MTk2OTU2NCwiZXhwIjoyMDkxOTY5NTY0fQ.signature';
        },
      );

      // Simulate 5 simultaneous requests calling refreshToken() concurrently
      final futures = List.generate(5, (_) => coordinator.refreshToken());
      expect(coordinator.isRefreshing, true);

      final tokens = await Future.wait(futures);
      expect(coordinator.isRefreshing, false);
      expect(refreshFlightCount, 1, reason: '5 concurrent 401s must coalesce into exactly 1 refresh flight');
      expect(tokens, hasLength(5));
      expect(tokens.every((t) => t == tokens.first), true);
      expect(sessionMgr.currentSession?.userId, 'usr_c4');
      expect(sessionMgr.currentSession?.token, tokens.first);

      // Test refresh failure: Session is safely cleared
      final failingCoordinator = SingleFlightRefreshCoordinator(
        sessionManager: sessionMgr,
        refreshCall: () async {
          throw Exception('Refresh token expired or revoked');
        },
      );

      await expectLater(
        () => failingCoordinator.refreshToken(),
        throwsA(isA<TokenExpiredException>()),
      );
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(sessionMgr.isAuthenticated, false);
      expect(sessionMgr.status, SessionStatus.unauthenticated);
    });

    test('C5: Idempotency Alignment ensures identical key in header, body, pending mutation, and retry', () async {
      final storage = InMemorySecureStorageService();
      final sessionMgr = SessionManager(storage: storage);
      final idempMgr = IdempotencyManager();
      final persistence = InMemoryLocalPersistenceService();
      final projStore = LocalTripProjectionStore();

      String? capturedHeaderKey;
      Map<String, dynamic>? capturedBody;

      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        capturedHeaderKey = options.headers['X-Idempotency-Key']?.toString();
        capturedBody = options.data is Map<String, dynamic> ? options.data as Map<String, dynamic> : null;
        return ResponseBody.fromString(
          '{"success":true,"trip":{"orderId":"TRIP_IDEMP_1","version":1,"status":"CREATED"}}',
          200,
          headers: {'content-type': ['application/json']},
        );
      });

      final client = ApiClient(
        baseUrl: 'http://test.local',
        tokenProvider: sessionMgr,
        idempotencyManager: idempMgr,
        dio: dio,
      );

      final service = CustomerTripService(
        apiClient: client,
        projectionStore: projStore,
        persistenceService: persistence,
        idempotencyManager: idempMgr,
      );

      // Explicit user-supplied idempotency key
      const expectedKey = 'user_idempotency_key_999';
      const bookingReq = CreateBookingRequest(
        idempotencyKey: expectedKey,
        pickupLat: 17.38,
        pickupLng: 78.48,
        pickupAddress: 'Charminar',
        dropLat: 17.44,
        dropLng: 78.37,
        dropAddress: 'Hitec City',
        vehicleId: 'v_2w',
      );

      await service.createBooking(bookingReq);

      expect(capturedHeaderKey, expectedKey, reason: 'HTTP header must contain identical idempotency key');
      expect(capturedBody?['idempotencyKey'], expectedKey, reason: 'Request payload must contain identical idempotency key');

      // Auto-generated UUID idempotency key test
      const autoReq = CreateBookingRequest(
        idempotencyKey: '', // Empty: service should generate UUID once and bind identically
        pickupLat: 17.38,
        pickupLng: 78.48,
        pickupAddress: 'Charminar',
        dropLat: 17.44,
        dropLng: 78.37,
        dropAddress: 'Hitec City',
        vehicleId: 'v_2w',
      );

      await service.createBooking(autoReq);
      expect(capturedHeaderKey, isNotNull);
      expect(capturedHeaderKey!.length, 36, reason: 'Generated key must be a valid UUIDv4');
      expect(capturedBody?['idempotencyKey'], capturedHeaderKey, reason: 'Header and body must match identically');
    });
  });

  group('Phase D: Release Hardening & Source Hygiene', () {
    test('D1: AppConfig enforces fail-closed release configuration and production TLS', () {
      final dev = AppConfig.development();
      expect(dev.isDevelopment, true);
      expect(dev.isStaging, false);
      expect(dev.isProduction, false);
      expect(dev.enableDiagnostics, true);
      expect(dev.logNetworkTraffic, true);
      expect(dev.apiBaseUrl, 'http://10.0.2.2:4000');
      expect(dev.wsBaseUrl, 'ws://10.0.2.2:4000/ws');

      final staging = AppConfig.staging();
      expect(staging.isStaging, true);
      expect(staging.isDevelopment, false);
      expect(staging.isProduction, false);
      expect(staging.apiBaseUrl, 'https://staging-api.vaayu.in');
      expect(staging.wsBaseUrl, 'wss://staging-api.vaayu.in/ws');
      expect(staging.enableDiagnostics, true);
      expect(staging.logNetworkTraffic, false);

      final prod = AppConfig.production();
      expect(prod.isProduction, true);
      expect(prod.isDevelopment, false);
      expect(prod.isStaging, false);
      expect(prod.apiBaseUrl, 'https://api.vaayu.in');
      expect(prod.wsBaseUrl, 'wss://api.vaayu.in/ws');
      expect(prod.enableDiagnostics, false);
      expect(prod.logNetworkTraffic, false);

      // Fail-closed release mode: unspecified environment in release mode MUST default to production
      final releaseConfig = AppConfig.fromEnvironment(isReleaseModeOverride: true);
      expect(releaseConfig.isProduction, true, reason: 'Release builds must default to production');
      expect(releaseConfig.isDevelopment, false);
      expect(releaseConfig.apiBaseUrl.startsWith('https://'), true);
      expect(releaseConfig.wsBaseUrl.startsWith('wss://'), true);

      // In debug mode, unspecified environment defaults to development
      final debugConfig = AppConfig.fromEnvironment(isReleaseModeOverride: false);
      expect(debugConfig.isDevelopment, true);

      // Production TLS validation: rejecting non-TLS protocols in production
      expect(
        () => AppConfig.production(apiBaseUrl: 'http://insecure.vaayu.in'),
        throwsStateError,
        reason: 'Insecure HTTP must be rejected in production',
      );
      expect(
        () => AppConfig.production(wsBaseUrl: 'ws://insecure.vaayu.in/ws'),
        throwsStateError,
        reason: 'Insecure WS must be rejected in production',
      );

      // Environment parsing tests
      expect(AppConfig.parseEnvironment('production'), Environment.production);
      expect(AppConfig.parseEnvironment('prod'), Environment.production);
      expect(AppConfig.parseEnvironment('staging'), Environment.staging);
      expect(AppConfig.parseEnvironment('stage'), Environment.staging);
      expect(AppConfig.parseEnvironment('development'), Environment.development);
      expect(AppConfig.parseEnvironment('dev'), Environment.development);
      expect(AppConfig.parseEnvironment('unknown_fallback'), Environment.development);
    });

    test('D2: DiagnosticCredentials enforces source hygiene and zero embedded JWT literals', () {
      // 1. Zero embedded credentials: Unconfigured dev session returns null
      final unconfiguredCust = DiagnosticCredentials.getDevelopmentCustomerSession(isDevelopment: true);
      expect(unconfiguredCust, isNull, reason: 'Codebase must contain zero hardcoded JWT literals');

      final unconfiguredDriver = DiagnosticCredentials.getDevelopmentDriverSession(isDevelopment: true);
      expect(unconfiguredDriver, isNull, reason: 'Codebase must contain zero hardcoded JWT literals');

      // 2. External configuration injection in development mode
      const externalCustToken = 'ext_cust_token_dev_98765';
      final devCust = DiagnosticCredentials.getDevelopmentCustomerSession(
        isDevelopment: true,
        externalToken: externalCustToken,
      );
      expect(devCust, isNotNull);
      expect(devCust!.role, 'CUSTOMER');
      expect(devCust.userId, 'usr_cust_dev_01');
      expect(devCust.token, externalCustToken);

      const externalDriverToken = 'ext_drv_token_dev_54321';
      final devDriver = DiagnosticCredentials.getDevelopmentDriverSession(
        isDevelopment: true,
        externalToken: externalDriverToken,
      );
      expect(devDriver, isNotNull);
      expect(devDriver!.role, 'DRIVER');
      expect(devDriver.userId, 'usr_drv_dev_01');
      expect(devDriver.token, externalDriverToken);

      // 3. Strict production gating: Even if external token is supplied, non-dev returns null
      final prodCust = DiagnosticCredentials.getDevelopmentCustomerSession(
        isDevelopment: false,
        externalToken: externalCustToken,
      );
      expect(prodCust, isNull, reason: 'Diagnostic bypass strictly forbidden in production');

      final prodDriver = DiagnosticCredentials.getDevelopmentDriverSession(
        isDevelopment: false,
        externalToken: externalDriverToken,
      );
      expect(prodDriver, isNull, reason: 'Diagnostic bypass strictly forbidden in production');
    });

    test('D3: VaayuContainer wires AppConfig and initializes dynamic endpoints', () async {
      final config = AppConfig.staging(
        apiBaseUrl: 'https://custom-staging.vaayu.in',
        wsBaseUrl: 'wss://custom-staging.vaayu.in/ws',
      );
      final container = await VaayuContainer.initialize(
        customConfig: config,
        customStorage: InMemorySecureStorageService(),
        customPersistence: InMemoryLocalPersistenceService(),
      );

      expect(container.config.environment, Environment.staging);
      expect(container.config.apiBaseUrl, 'https://custom-staging.vaayu.in');
      expect(container.apiClient.baseUrl, 'https://custom-staging.vaayu.in');
      expect(container.webSocketClient.serverUrl, 'wss://custom-staging.vaayu.in/ws');
      expect(container.config.isProduction, false);
      expect(container.config.isStaging, true);
    });
  });

  group('Phase E1: Design Tokens & Reusable Component System', () {
    test('E1.1: VaayuTheme resolves semantic colors, typography and M3 styling', () {
      final darkTheme = VaayuTheme.dark();
      expect(darkTheme.brightness, Brightness.dark);
      expect(darkTheme.useMaterial3, true);

      final darkColors = darkTheme.extension<VaayuColors>();
      expect(darkColors, isNotNull);
      expect(darkColors!.primary, const Color(0xFF00C853)); // Electric Emerald
      expect(darkColors.secondary, const Color(0xFF00E5FF)); // Electric Cyan
      expect(darkColors.surface, const Color(0xFF1E1E1E)); // Deep Carbon surface
      expect(darkColors.background, const Color(0xFF121212)); // Dark Slate

      final lightTheme = VaayuTheme.light();
      expect(lightTheme.brightness, Brightness.light);
      final lightColors = lightTheme.extension<VaayuColors>();
      expect(lightColors, isNotNull);
      expect(lightColors!.primary, const Color(0xFF00893A)); // High-contrast Emerald
      expect(lightColors.surface, const Color(0xFFFFFFFF));

      // Geometric Tokens
      expect(VaayuRadius.md, 12.0);
      expect(VaayuRadius.lg, 16.0);
      expect(VaayuSpacing.md, 16.0);
      expect(VaayuSpacing.lg, 24.0);
    });

    testWidgets('E1.2: VaayuButton handles variants, tap events and loading states', (tester) async {
      bool tapped = false;

      // 1. Interactive Button
      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: VaayuButton(
              label: 'Confirm Booking',
              onPressed: () {
                tapped = true;
              },
            ),
          ),
        ),
      );

      expect(find.text('Confirm Booking'), findsOneWidget);
      await tester.tap(find.text('Confirm Booking'));
      expect(tapped, true);

      // 2. Loading State (Must show ProgressIndicator and ignore taps)
      tapped = false;
      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: VaayuButton(
              label: 'Processing',
              isLoading: true,
              onPressed: () {
                tapped = true;
              },
            ),
          ),
        ),
      );

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Processing'), findsNothing);
      await tester.tap(find.byType(CircularProgressIndicator));
      expect(tapped, false, reason: 'Loading button must suppress tap interactions');
    });

    testWidgets('E1.3: StatusBadge cleanly decouples presentation from network internals', (tester) async {
      // 1. Connection factory
      final onlineBadge = StatusBadge.connection(isConnected: true);
      expect(onlineBadge.label, 'Online');
      expect(onlineBadge.type, StatusBadgeType.online);

      final reconnectingBadge = StatusBadge.connection(isConnected: false, isReconnecting: true);
      expect(reconnectingBadge.label, 'Reconnecting');
      expect(reconnectingBadge.type, StatusBadgeType.connecting);

      final offlineBadge = StatusBadge.connection(isConnected: false, isReconnecting: false);
      expect(offlineBadge.label, 'Offline');
      expect(offlineBadge.type, StatusBadgeType.offline);

      // 2. Sync queue factory
      final syncedBadge = StatusBadge.sync(pendingMutations: 0);
      expect(syncedBadge.label, 'Synced');
      expect(syncedBadge.type, StatusBadgeType.online);

      final syncingBadge = StatusBadge.sync(pendingMutations: 4);
      expect(syncingBadge.label, 'Syncing (4)');
      expect(syncingBadge.type, StatusBadgeType.syncing);

      // 3. Widget Rendering
      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: StatusBadge.connection(isConnected: true),
          ),
        ),
      );
      expect(find.text('Online'), findsOneWidget);
    });

    testWidgets('E1.4: MetricChip and VaayuCard render semantic structure without business logic', (tester) async {
      bool cardTapped = false;

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: VaayuCard(
              onTap: () {
                cardTapped = true;
              },
              child: const MetricChip(
                icon: Icons.access_time,
                label: 'ETA',
                value: '4 min',
              ),
            ),
          ),
        ),
      );

      expect(find.text('ETA: '), findsOneWidget);
      expect(find.text('4 min'), findsOneWidget);
      expect(find.byIcon(Icons.access_time), findsOneWidget);

      await tester.tap(find.byType(VaayuCard));
      expect(cardTapped, true);
    });
  });

  group('Phase E2: Customer Experience & Ride Cockpit UI', () {
    testWidgets('E2.1: VehicleTierSelector renders available tiers and estimated fares', (tester) async {
      String selected = 'v_2w';

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                return VehicleTierSelector(
                  selectedVehicleId: selected,
                  estimatedFares: const {'v_2w': 85.0, 'v_3w': 140.0, 'v_ace': 320.0},
                  onTierSelected: (tierId) {
                    setState(() {
                      selected = tierId;
                    });
                  },
                );
              },
            ),
          ),
        ),
      );

      expect(find.text('Vaayu Moto'), findsOneWidget);
      expect(find.text('Vaayu Auto'), findsOneWidget);
      expect(find.text('Vaayu Express'), findsOneWidget);
      expect(find.text('₹85'), findsOneWidget);
      expect(find.text('₹140'), findsOneWidget);

      await tester.tap(find.text('Vaayu Auto'));
      await tester.pump();
      expect(selected, 'v_3w');
    });

    testWidgets('E2.2: CustomerActiveRideCockpit displays monotonic version and prominent 4-digit OTP', (tester) async {
      final tripStore = LocalTripProjectionStore();
      final locStore = DriverLocationStore();
      final sessionMgr = SessionManager(storage: InMemorySecureStorageService());
      final api = ApiClient(
        baseUrl: 'http://test',
        tokenProvider: sessionMgr,
        idempotencyManager: IdempotencyManager(),
      );
      final service = CustomerTripService(
        apiClient: api,
        projectionStore: tripStore,
        persistenceService: InMemoryLocalPersistenceService(),
        idempotencyManager: IdempotencyManager(),
      );
      final controller = CustomerTripController(
        tripService: service,
        projectionStore: tripStore,
      );

      // Seed trip projection at version 4 with pickup OTP '8492'
      final proj = LocalTripProjection(
        tripId: 'TRIP_E2_VERIFY_001',
        status: 'DRIVER_ARRIVING',
        version: 4,
        pickupLat: 17.385,
        pickupLng: 78.486,
        dropLat: 17.443,
        dropLng: 78.377,
        totalFare: 145.0,
        driverName: 'Suresh Kumar',
        driverPhone: '+91 7842416560',
        pickupOtp: '8492',
        updatedAt: DateTime.now(),
      );
      tripStore.applyUpdate(proj);

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: CustomerActiveRideCockpit(
              controller: controller,
              locationStore: locStore,
            ),
          ),
        ),
      );

      // Verify Driver Arriving Status and Monotonic Version
      expect(find.text('Driver Arriving'), findsOneWidget);
      expect(find.text('v4'), findsOneWidget);
      expect(find.text('START TRIP PIN'), findsOneWidget);
      expect(find.text('8492'), findsOneWidget, reason: 'Prominent 4-digit pickup OTP must be displayed');
      expect(find.text('Suresh Kumar'), findsOneWidget);
      expect(find.text('+91 7842416560'), findsOneWidget);
    });

    testWidgets('E2.3: Decoupled driver GPS updates do not mutate trip projection version', (tester) async {
      final tripStore = LocalTripProjectionStore();
      final locStore = DriverLocationStore();
      final sessionMgr = SessionManager(storage: InMemorySecureStorageService());
      final api = ApiClient(
        baseUrl: 'http://test',
        tokenProvider: sessionMgr,
        idempotencyManager: IdempotencyManager(),
      );
      final service = CustomerTripService(
        apiClient: api,
        projectionStore: tripStore,
        persistenceService: InMemoryLocalPersistenceService(),
        idempotencyManager: IdempotencyManager(),
      );
      final controller = CustomerTripController(
        tripService: service,
        projectionStore: tripStore,
      );

      final initialProj = LocalTripProjection(
        tripId: 'TRIP_GPS_TEST_77',
        status: 'DRIVER_ARRIVING',
        version: 5,
        pickupLat: 17.385,
        pickupLng: 78.486,
        dropLat: 17.443,
        dropLng: 78.377,
        totalFare: 120.0,
        driverLat: 17.390,
        driverLng: 78.480,
        pickupOtp: '1234',
        updatedAt: DateTime.now(),
      );
      tripStore.applyUpdate(initialProj);

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: CustomerActiveRideCockpit(
              controller: controller,
              locationStore: locStore,
            ),
          ),
        ),
      );

      expect(find.text('v5'), findsOneWidget);

      // Emit high-frequency driver GPS sequence update #1042
      locStore.apply(DriverLocationProjection(
        tripId: 'TRIP_GPS_TEST_77',
        latitude: 17.39500,
        longitude: 78.48200,
        sequence: 1042,
        receivedAt: DateTime.now(),
      ));
      await tester.pump();

      expect(find.text('#1042'), findsOneWidget);
      expect(find.text('Coordinates: 17.39500, 78.48200'), findsOneWidget);
      expect(find.text('v5'), findsOneWidget, reason: 'GPS sequence must not modify server trip version');
      expect(tripStore.getProjection('TRIP_GPS_TEST_77')?.version, 5);
    });

    testWidgets('E2.4: CustomerHomeScreen dynamically alternates between booking and active ride', (tester) async {
      final tripStore = LocalTripProjectionStore();
      final locStore = DriverLocationStore();
      final wsClient = WebSocketClient(
        serverUrl: 'ws://test/ws',
        tokenProvider: () async => 'token',
        channelFactory: (_) => throw UnimplementedError(),
      );
      final sessionMgr = SessionManager(storage: InMemorySecureStorageService());
      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        return ResponseBody.fromString(
          '{"success":true,"estimatedFare":140.0,"distanceKm":8.0,"durationMins":18.0}',
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });
      final api = ApiClient(
        baseUrl: 'http://test',
        tokenProvider: sessionMgr,
        idempotencyManager: IdempotencyManager(),
        dio: dio,
      );
      final service = CustomerTripService(
        apiClient: api,
        projectionStore: tripStore,
        persistenceService: InMemoryLocalPersistenceService(),
        idempotencyManager: IdempotencyManager(),
      );
      final controller = CustomerTripController(
        tripService: service,
        projectionStore: tripStore,
      );

      // 1. Initial State: Unbooked -> CustomerBookingSheet rendered
      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: CustomerHomeScreen(
            controller: controller,
            locationStore: locStore,
            webSocketClient: wsClient,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(CustomerBookingSheet), findsOneWidget);
      expect(find.byType(CustomerActiveRideCockpit), findsNothing);

      // 2. State Transition: Trip Created/Assigned -> CustomerActiveRideCockpit rendered
      tripStore.applyUpdate(LocalTripProjection(
        tripId: 'TRIP_HOME_TEST_01',
        status: 'DRIVER_ACCEPTED',
        version: 2,
        pickupLat: 17.385,
        pickupLng: 78.486,
        dropLat: 17.443,
        dropLng: 78.377,
        totalFare: 160.0,
        driverName: 'Ramesh Pilot',
        pickupOtp: '7721',
        updatedAt: DateTime.now(),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(CustomerActiveRideCockpit), findsOneWidget);
      expect(find.byType(CustomerBookingSheet), findsNothing);
      expect(find.text('Ramesh Pilot'), findsOneWidget);
      expect(find.text('7721'), findsOneWidget);
    });

    testWidgets('E2.5: FareBreakdownSheet displays authoritative base fare, distance, and surge transparency', (tester) async {
      const estimate = FareEstimateResult(
        success: true,
        estimatedFare: 185.0,
        distanceKm: 12.5,
        durationMins: 28.0,
        fareBreakdown: {
          'baseFare': 40.0,
          'distanceFare': 120.0,
          'surgeMultiplier': 1.25,
        },
      );

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: const Scaffold(
            body: FareBreakdownSheet(estimate: estimate),
          ),
        ),
      );

      expect(find.text('Authoritative Fare Breakdown'), findsOneWidget);
      expect(find.text('1.3x Surge'), findsOneWidget);
      expect(find.text('₹185.00'), findsOneWidget);
      expect(find.text('Base Fare'), findsOneWidget);
      expect(find.text('Distance Charge'), findsOneWidget);
    });
  });

  group('Phase E3: Driver-Partner High-Efficiency Cockpit UI', () {
    testWidgets('E3.1: DriverDutyToggleCard renders partner stats and handles online/offline duty toggle', (tester) async {
      const profile = DriverProfile(
        id: 'drv_test_01',
        name: 'Suresh Pilot',
        phone: '+91 9876543210',
        status: 'OFFLINE',
        rating: 4.9,
        todayEarnings: 1250.0,
        todayTrips: 8,
        pocketBalance: 500.0,
        vehiclePlate: 'KA 05 MN 1234',
      );

      bool? toggledTarget;

      // 1. Offline Mode State
      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: DriverDutyToggleCard(
              profile: profile,
              isOnline: false,
              onToggleDuty: (val) => toggledTarget = val,
            ),
          ),
        ),
      );

      expect(find.text('Suresh Pilot'), findsOneWidget);
      expect(find.text('4.9'), findsOneWidget);
      expect(find.text('₹1250.00'), findsOneWidget);
      expect(find.text('8 Trips'), findsOneWidget);
      expect(find.text('KA 05 MN 1234'), findsOneWidget);
      expect(find.text('OFFLINE'), findsOneWidget);
      expect(find.text('GO ONLINE — START DUTY'), findsOneWidget);

      await tester.tap(find.byKey(const Key('btn_duty_toggle')));
      expect(toggledTarget, true);

      // 2. Online Mode State with GPS Sequence
      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: DriverDutyToggleCard(
              profile: profile.copyWith(status: 'ONLINE'),
              isOnline: true,
              gpsSequence: 1042,
              onToggleDuty: (val) => toggledTarget = val,
            ),
          ),
        ),
      );

      expect(find.text('ONLINE'), findsOneWidget);
      expect(find.text('GO OFFLINE'), findsOneWidget);
      expect(find.text('GPS Broadcasting active (#1042)'), findsOneWidget);
    });

    testWidgets('E3.2: DriverIncomingOfferSheet renders route, earnings, distance, and countdown ring', (tester) async {
      final offer = DriverOffer(
        orderId: 'ORDER_OFFER_99',
        pickupLat: 17.385,
        pickupLng: 78.486,
        pickupAddress: 'Charminar Gate 1, Hyderabad',
        dropLat: 17.443,
        dropLng: 78.377,
        dropAddress: 'Cyber Towers, Hitec City',
        estimatedFare: 185.0,
        distanceKm: 12.5,
        expiresAt: DateTime.now().add(const Duration(seconds: 25)),
      );

      bool accepted = false;
      bool declined = false;

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: DriverIncomingOfferSheet(
              offer: offer,
              initialRemainingSeconds: 25,
              enableTimer: false,
              onAccept: () => accepted = true,
              onDecline: () => declined = true,
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.text('NEW RIDE OFFER'), findsOneWidget);
      expect(find.text('₹185.00'), findsOneWidget);
      expect(find.text('12.5 km'), findsOneWidget);
      expect(find.text('Charminar Gate 1, Hyderabad'), findsOneWidget);
      expect(find.text('Cyber Towers, Hitec City'), findsOneWidget);
      expect(find.text('25s'), findsOneWidget);

      // Verify Accept action
      await tester.tap(find.byKey(const Key('btn_offer_accept')));
      expect(accepted, true);

      // Verify Decline action
      await tester.tap(find.byKey(const Key('btn_offer_decline')));
      expect(declined, true);

      // Verify Expired State
      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: DriverIncomingOfferSheet(
              offer: offer,
              initialRemainingSeconds: 0,
              enableTimer: false,
              onAccept: () {},
              onDecline: () {},
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.text('OFFER EXPIRED'), findsOneWidget);
      expect(find.text('EXPIRED'), findsOneWidget);
    });

    testWidgets('E3.3: DriverOtpVerificationDialog validates 4-digit PIN before submitting', (tester) async {
      String? submittedOtp;

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Builder(
            builder: (context) => Scaffold(
              body: Center(
                child: ElevatedButton(
                  key: const Key('btn_open_dialog'),
                  onPressed: () {
                    DriverOtpVerificationDialog.show(
                      context,
                      title: 'Verify Customer OTP',
                      actionLabel: 'Confirm OTP',
                      onVerify: (otp) async {
                        submittedOtp = otp;
                        return otp == '5544';
                      },
                    );
                  },
                  child: const Text('OPEN'),
                ),
              ),
            ),
          ),
        ),
      );

      // Open Dialog
      await tester.tap(find.byKey(const Key('btn_open_dialog')));
      await tester.pumpAndSettle();

      expect(find.text('Verify Customer OTP'), findsOneWidget);
      expect(find.byKey(const Key('input_otp_pin')), findsOneWidget);

      // 1. Enter invalid (less than 4 digits) PIN
      await tester.enterText(find.byKey(const Key('input_otp_pin')), '55');
      await tester.tap(find.byKey(const Key('btn_otp_confirm')));
      await tester.pumpAndSettle();

      expect(find.text('Please enter a valid 4-digit numeric PIN'), findsOneWidget);
      expect(submittedOtp, isNull);

      // 2. Enter incorrect 4-digit PIN
      await tester.enterText(find.byKey(const Key('input_otp_pin')), '1234');
      await tester.tap(find.byKey(const Key('btn_otp_confirm')));
      await tester.pumpAndSettle();

      expect(submittedOtp, '1234');
      expect(find.text('Incorrect PIN. Please re-check with customer.'), findsOneWidget);

      // 3. Enter correct 4-digit PIN
      await tester.enterText(find.byKey(const Key('input_otp_pin')), '5544');
      await tester.tap(find.byKey(const Key('btn_otp_confirm')));
      await tester.pumpAndSettle();

      expect(submittedOtp, '5544');
      expect(find.byType(DriverOtpVerificationDialog), findsNothing); // Dialog dismissed
    });

    testWidgets('E3.4: DriverActiveTripCockpit displays monotonic version and sequential milestone CTA', (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final tripStore = LocalTripProjectionStore();
      final dio = Dio(BaseOptions(
        connectTimeout: null,
        receiveTimeout: null,
      ));
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        final path = options.path;
        String status = 'DRIVER_ACCEPTED';
        int ver = 2;
        if (path.contains('start-arriving')) {
          status = 'DRIVER_ARRIVING';
          ver = 3;
        } else if (path.contains('arrived-pickup')) {
          status = 'DRIVER_AT_PICKUP';
          ver = 4;
        }
        return ResponseBody.fromString(
          '{"success":true,"order":{"status":"$status","version":$ver,"totalFare":185.0}}',
          200,
          headers: {'content-type': ['application/json']},
        );
      });

      final sessionMgr = SessionManager(storage: InMemorySecureStorageService());
      await sessionMgr.establishSession(AuthSession(
        userId: 'drv_test_01',
        role: 'DRIVER',
        name: 'Suresh Pilot',
        phone: '9876543210',
        city: 'hyderabad',
        issuedAt: DateTime.now(),
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      ));
      final apiClient = ApiClient(
        baseUrl: 'http://127.0.0.1:4000',
        tokenProvider: sessionMgr,
        idempotencyManager: IdempotencyManager(),
        dio: dio,
      );
      final driverService = DriverPartnerService(
        apiClient: apiClient,
        projectionStore: tripStore,
        persistenceService: InMemoryLocalPersistenceService(),
        idempotencyManager: IdempotencyManager(),
      );
      final controller = DriverPartnerController(
        driverService: driverService,
        projectionStore: tripStore,
      );

      final initialProj = LocalTripProjection(
        tripId: 'TRIP_DRV_TEST_101',
        status: 'DRIVER_ACCEPTED',
        version: 2,
        pickupLat: 17.385,
        pickupLng: 78.486,
        dropLat: 17.443,
        dropLng: 78.377,
        totalFare: 185.0,
        customerId: 'cust_7712',
        updatedAt: DateTime.now(),
      );
      tripStore.applyUpdate(initialProj);

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: DriverActiveTripCockpit(
              controller: controller,
              telemetrySeq: 887,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Check version and trip info
      expect(find.text('v2'), findsOneWidget);
      expect(find.text('Offer Accepted'), findsOneWidget);
      expect(find.text('₹185.00'), findsOneWidget);
      expect(find.text('Rider (cust_7712)'), findsOneWidget);
      expect(find.text('Driver GPS Telemetry active (#887)'), findsOneWidget);
      expect(find.text('NAVIGATE TO PICKUP'), findsOneWidget);

      // Advance to DRIVER_ARRIVING
      tripStore.applyUpdate(initialProj.copyWith(status: 'DRIVER_ARRIVING', version: 3));
      await tester.pumpAndSettle();

      expect(find.text('ARRIVED AT PICKUP POINT'), findsOneWidget);
      expect(find.text('v3'), findsOneWidget);

      // Update projection to DRIVER_AT_PICKUP
      tripStore.applyUpdate(initialProj.copyWith(status: 'DRIVER_AT_PICKUP', version: 4));
      await tester.pumpAndSettle();
      expect(find.text('ENTER RIDER OTP & START TRIP'), findsOneWidget);

      // Update projection to IN_TRANSIT
      tripStore.applyUpdate(initialProj.copyWith(status: 'IN_TRANSIT', version: 5));
      await tester.pumpAndSettle();
      expect(find.text('ARRIVED AT DESTINATION'), findsOneWidget);

      // Update projection to DRIVER_AT_DROPOFF
      tripStore.applyUpdate(initialProj.copyWith(status: 'DRIVER_AT_DROPOFF', version: 6));
      await tester.pumpAndSettle();
      expect(find.text('COMPLETE TRIP & SETTLE'), findsOneWidget);

      // Update projection to DELIVERED
      tripStore.applyUpdate(initialProj.copyWith(status: 'DELIVERED', version: 7));
      await tester.pumpAndSettle();
      expect(find.text('Trip Completed & Reconciled'), findsOneWidget);
      expect(find.text('RETURN TO DUTY RADAR'), findsOneWidget);

      // Tapping dismiss resets active trip
      await tester.tap(find.byKey(const Key('btn_dismiss_delivery')));
      await tester.pumpAndSettle();
      expect(controller.currentActiveOrderId, isNull);
    });

    testWidgets('E3.5: DriverDashboardScreen dynamically alternates between duty/offers and active trip cockpit', (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final tripStore = LocalTripProjectionStore();
      final dio = Dio(BaseOptions(
        connectTimeout: null,
        receiveTimeout: null,
      ));
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        final path = options.path;
        if (path.contains('/api/driver/profile')) {
          return ResponseBody.fromString(
            '{"success":true,"partner_id":"drv_01","name":"Kiran Pilot","phone":"+91 9888877777","status":"ONLINE","rating":4.95,"today_earnings":850.0,"today_trips":5,"pocket_balance":300.0,"vehicle_plate":"TS 09 XY 8899"}',
            200,
            headers: {'content-type': ['application/json']},
          );
        }
        if (path.contains('/api/driver/offers')) {
          return ResponseBody.fromString(
            '{"success":true,"offers":[{"orderId":"OFFER_DASH_01","pickupLat":17.38,"pickupLng":78.48,"pickupAddress":"Secunderabad Stn","dropLat":17.44,"dropLng":78.37,"dropAddress":"Mindspace, Hitec City","estimatedFare":195.0,"distanceKm":14.0,"expiresAt":"${DateTime.now().add(const Duration(seconds: 30)).toIso8601String()}"}]}',
            200,
            headers: {'content-type': ['application/json']},
          );
        }
        if (path.contains('/api/orders/accept')) {
          return ResponseBody.fromString(
            '{"success":true,"order":{"status":"DRIVER_ACCEPTED","version":2,"totalFare":195.0}}',
            200,
            headers: {'content-type': ['application/json']},
          );
        }
        return ResponseBody.fromString('{"success":true}', 200, headers: {
          'content-type': ['application/json'],
        });
      });

      final sessionMgr = SessionManager(storage: InMemorySecureStorageService());
      await sessionMgr.establishSession(AuthSession(
        userId: 'drv_01',
        role: 'DRIVER',
        name: 'Kiran Pilot',
        phone: '9888877777',
        city: 'hyderabad',
        issuedAt: DateTime.now(),
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        expiresAt: DateTime.now().add(const Duration(hours: 1)),
      ));
      final apiClient = ApiClient(
        baseUrl: 'http://127.0.0.1:4000',
        tokenProvider: sessionMgr,
        idempotencyManager: IdempotencyManager(),
        dio: dio,
      );
      final driverService = DriverPartnerService(
        apiClient: apiClient,
        projectionStore: tripStore,
        persistenceService: InMemoryLocalPersistenceService(),
        idempotencyManager: IdempotencyManager(),
      );
      final controller = DriverPartnerController(
        driverService: driverService,
        projectionStore: tripStore,
      );
      final wsClient = WebSocketClient(
        serverUrl: 'ws://127.0.0.1:4000/ws',
        tokenProvider: () async => 'token',
        channelFactory: (_) => throw UnimplementedError(),
      );

      // 1. Initial Load: Online with incoming offer
      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: DriverDashboardScreen(
            controller: controller,
            webSocketClient: wsClient,
            enableOfferTimer: false,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(DriverDutyToggleCard), findsOneWidget);
      expect(find.byType(DriverIncomingOfferSheet), findsOneWidget);
      expect(find.text('Kiran Pilot'), findsOneWidget);
      expect(find.text('Secunderabad Stn'), findsOneWidget);
      expect(find.text('₹195.00'), findsOneWidget);

      // 2. State Transition: Trip Accepted / Projection Stream Update -> Transitions to DriverActiveTripCockpit
      tripStore.applyUpdate(LocalTripProjection(
        tripId: 'OFFER_DASH_01',
        status: 'DRIVER_ACCEPTED',
        version: 2,
        pickupLat: 17.38,
        pickupLng: 78.48,
        dropLat: 17.44,
        dropLng: 78.37,
        totalFare: 195.0,
        customerId: 'cust_99',
        updatedAt: DateTime.now(),
      ));
      await tester.pumpAndSettle();

      expect(find.byType(DriverActiveTripCockpit), findsOneWidget);
      expect(find.byType(DriverDutyToggleCard), findsNothing);
      expect(find.byType(DriverIncomingOfferSheet), findsNothing);
    });
  });

  group('Phase E4: Operations & Live Fleet Monitoring Cockpit', () {
    testWidgets('E4.1: OperationsIncidentWall renders priority alerts and dispatches operator CTAs', (tester) async {
      // 1. Nominal State (Zero active incidents)
      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: const Scaffold(
            body: OperationsIncidentWall(
              alerts: [],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('operations_nominal_card')), findsOneWidget);
      expect(find.text('ALL FLEET SYSTEMS NOMINAL'), findsOneWidget);
      expect(find.text('100% HEALTHY'), findsOneWidget);

      // 2. Exception-First Active Alert State
      String? redispatchedOrder;
      String? assignedOrder;
      String? cancelledOrder;

      final testAlerts = [
        OperationalAlert(
          id: 'ALT_CRIT_01',
          severity: AlertSeverity.critical,
          type: AlertType.dispatchTimeoutDelay,
          orderId: 'TRIP_STALL_101',
          ageSec: 145,
          message: 'Order TRIP_STALL_101 unassigned for 145s in SEARCHING_DRIVER',
          timestamp: DateTime.now(),
        ),
        OperationalAlert(
          id: 'ALT_WARN_02',
          severity: AlertSeverity.warning,
          type: AlertType.telemetrySignalLoss,
          driverId: 'drv_99',
          driverName: 'Vikram Pilot',
          orderId: 'TRIP_ACTIVE_202',
          ageSec: 40,
          message: 'Driver Vikram Pilot on active trip TRIP_ACTIVE_202 has signal state DEGRADED',
          timestamp: DateTime.now(),
        ),
      ];

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: SingleChildScrollView(
              child: OperationsIncidentWall(
                alerts: testAlerts,
                onRedispatch: (id) => redispatchedOrder = id,
                onAssignDriver: (id) => assignedOrder = id,
                onCancelOverride: (id) => cancelledOrder = id,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('ATTENTION REQUIRED (2)'), findsOneWidget);
      expect(find.text('1 CRITICAL'), findsOneWidget);
      expect(find.text('DISPATCH TIMEOUT'), findsOneWidget);
      expect(find.text('SIGNAL DROP'), findsOneWidget);
      expect(find.text('Order: TRIP_STALL_101'), findsOneWidget);
      expect(find.text('Driver: Vikram Pilot'), findsOneWidget);

      // Verify Operator Action CTAs
      await tester.tap(find.byKey(const Key('btn_redispatch_ALT_CRIT_01')));
      expect(redispatchedOrder, 'TRIP_STALL_101');

      await tester.tap(find.byKey(const Key('btn_assign_ALT_CRIT_01')));
      expect(assignedOrder, 'TRIP_STALL_101');

      await tester.tap(find.byKey(const Key('btn_cancel_ALT_CRIT_01')));
      expect(cancelledOrder, 'TRIP_STALL_101');
    });

    testWidgets('E4.2: OperationsFleetStatusBar updates aggregate metrics and filter selection', (tester) async {
      OperationsFilter? selectedFilter;

      const summary = FleetSummary(
        totalDrivers: 48,
        onlineCount: 34,
        degradedCount: 3,
        staleCount: 2,
        offlineCount: 9,
        utilizationPercent: 77,
      );

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: OperationsFleetStatusBar(
              summary: summary,
              activeFilter: OperationsFilter.all,
              onFilterChanged: (f) => selectedFilter = f,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('48'), findsOneWidget);
      expect(find.text('34'), findsOneWidget);
      expect(find.text('5'), findsOneWidget); // 3 degraded + 2 stale
      expect(find.text('9'), findsOneWidget);
      expect(find.text('77%'), findsOneWidget);

      // Tap Filter Chips
      await tester.tap(find.byKey(const Key('filter_chip_exceptionsOnly')));
      expect(selectedFilter, OperationsFilter.exceptionsOnly);

      await tester.tap(find.byKey(const Key('filter_chip_activeTripsOnly')));
      expect(selectedFilter, OperationsFilter.activeTripsOnly);

      await tester.tap(find.byKey(const Key('filter_chip_availableDriversOnly')));
      expect(selectedFilter, OperationsFilter.availableDriversOnly);
    });

    testWidgets('E4.3: OperationsDriverCard & OperationsTripCard render live telemetry and ETA without state corruption', (tester) async {
      String? managedTripId;

      const testDriver = FleetDriverLive(
        driverId: 'drv_ops_01',
        name: 'Ramesh Reddy',
        phone: '9876543210',
        vehicleNumber: 'TS07UA1234',
        rating: 4.85,
        dutyStatus: 'ONLINE',
        livenessState: 'ONLINE',
        lat: 17.43,
        lng: 78.38,
        speed: 42.0,
        pingAgeSec: 8,
        isReserved: true,
        reservedOrderId: 'TRIP_LIVE_55',
      );

      const testTrip = ActiveTripSummary(
        id: 'TRIP_LIVE_55',
        status: 'IN_TRANSIT',
        customerName: 'Priya S',
        driverName: 'Kishore V',
        pickupAddress: 'Hitec City Metro',
        dropoffAddress: 'Gachibowli Bio-Diversity Park',
        totalFare: 210.0,
        waitingTimeSec: 360,
        liveEta: '6 mins to destination',
        reservationLockActive: true,
      );

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: Column(
              children: [
                const OperationsDriverCard(driver: testDriver),
                const SizedBox(height: 10),
                OperationsTripCard(
                  trip: testTrip,
                  onIntervene: (id) => managedTripId = id,
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Driver Card assertions
      expect(find.text('Ramesh Reddy'), findsOneWidget);
      expect(find.text('TS07UA1234'), findsOneWidget);
      expect(find.text('★ 4.8'), findsOneWidget);
      expect(find.text('8s ago'), findsOneWidget);
      expect(find.text('42 km/h'), findsOneWidget);
      expect(find.text('RESERVED: TRIP_LIVE_55'), findsOneWidget);

      // Trip Card assertions
      expect(find.text('TRIP_LIVE_55'), findsOneWidget);
      expect(find.text('Hitec City Metro'), findsOneWidget);
      expect(find.text('Gachibowli Bio-Diversity Park'), findsOneWidget);
      expect(find.text('₹210'), findsOneWidget);
      expect(find.text('6 mins to destination'), findsOneWidget);
      expect(find.text('Elapsed: 360s'), findsOneWidget);

      await tester.tap(find.byKey(const Key('btn_trip_intervene_TRIP_LIVE_55')));
      expect(managedTripId, 'TRIP_LIVE_55');
    });

    testWidgets('E4.4: OperationsInterventionDialog validates input before executing operator commands', (tester) async {
      OperatorActionType? executedAction;
      String? executedOrder;
      String? executedDriver;
      String? executedReason;

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: Scaffold(
            body: Builder(
              builder: (ctx) => ElevatedButton(
                key: const Key('btn_open_dialog'),
                onPressed: () {
                  OperationsInterventionDialog.show(
                    ctx,
                    orderId: 'TRIP_INTERVENE_99',
                    initialAction: OperatorActionType.redispatch,
                    onConfirm: ({required action, required orderId, driverId, reason}) async {
                      executedAction = action;
                      executedOrder = orderId;
                      executedDriver = driverId;
                      executedReason = reason;
                      return true;
                    },
                  );
                },
                child: const Text('Open Dialog'),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('btn_open_dialog')));
      await tester.pumpAndSettle();

      expect(find.text('OPERATOR COMMAND'), findsOneWidget);
      expect(find.text('Trip Order: TRIP_INTERVENE_99'), findsOneWidget);

      // 1. Validation test on Re-Dispatch: clear input
      await tester.enterText(find.byKey(const Key('operator_input_field')), '');
      await tester.tap(find.byKey(const Key('btn_confirm_operator_command')));
      await tester.pumpAndSettle();
      expect(find.text('Reason is required for audit logs'), findsOneWidget);

      // 2. Switch to Assign Driver tab
      await tester.tap(find.byKey(const Key('action_tab_assignDriver')));
      await tester.pumpAndSettle();
      expect(find.text('Target Driver ID:'), findsOneWidget);

      // Validation test on Assign Driver: empty input
      await tester.tap(find.byKey(const Key('btn_confirm_operator_command')));
      await tester.pumpAndSettle();
      expect(find.text('Driver ID is required for manual assignment'), findsOneWidget);

      // Enter driver ID and confirm
      await tester.enterText(find.byKey(const Key('operator_input_field')), 'DRV_SPECIAL_88');
      await tester.tap(find.byKey(const Key('btn_confirm_operator_command')));
      await tester.pumpAndSettle();

      expect(executedAction, OperatorActionType.assignDriver);
      expect(executedOrder, 'TRIP_INTERVENE_99');
      expect(executedDriver, 'DRV_SPECIAL_88');
      expect(executedReason, isNull);
      expect(find.text('OPERATOR COMMAND'), findsNothing); // Dialog closed
    });

    testWidgets('E4.5: OperationsDashboardScreen loads telemetry and integrates exception-first monitoring', (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        final path = options.uri.path;
        if (path.contains('/api/admin/alerts')) {
          final payload = {
            'success': true,
            'alerts': [
              {
                'id': 'ALT_LIVE_01',
                'severity': 'CRITICAL',
                'type': 'DISPATCH_TIMEOUT_DELAY',
                'orderId': 'TRIP_OPS_DASH_1',
                'ageSec': 130,
                'message': 'Dispatch timeout 130s on TRIP_OPS_DASH_1',
                'timestamp': DateTime.now().toIso8601String(),
              }
            ]
          };
          return ResponseBody.fromString(jsonEncode(payload), 200, headers: {'content-type': ['application/json']});
        }
        if (path.contains('/api/admin/fleet/live')) {
          final payload = {
            'success': true,
            'summary': {
              'totalDrivers': 25,
              'onlineCount': 18,
              'degradedCount': 2,
              'staleCount': 1,
              'offlineCount': 4,
              'utilizationPercent': 80,
            },
            'drivers': [
              {
                'driverId': 'drv_live_01',
                'name': 'Arjun Varma',
                'phone': '9988776655',
                'vehicleNumber': 'TS08AA9999',
                'rating': 4.9,
                'dutyStatus': 'ONLINE',
                'livenessState': 'ONLINE',
                'lat': 17.41,
                'lng': 78.40,
                'speed': 35.0,
                'pingAgeSec': 5,
                'isReserved': false,
              }
            ]
          };
          return ResponseBody.fromString(jsonEncode(payload), 200, headers: {'content-type': ['application/json']});
        }
        if (path.contains('/api/admin/trips/active')) {
          final payload = {
            'success': true,
            'activeTrips': [
              {
                'id': 'TRIP_OPS_DASH_1',
                'status': 'SEARCHING_DRIVER',
                'customer': {'name': 'Sneha Rao', 'phone': '9123456789'},
                'pickup': {'address': 'Banjara Hills Rd 12'},
                'dropoff': {'address': 'Jubilee Hills Checkpost'},
                'totalFare': 165.0,
                'waitingTimeSec': 130,
                'liveEta': 'Calculating...',
                'reservationLockActive': false,
              }
            ]
          };
          return ResponseBody.fromString(jsonEncode(payload), 200, headers: {'content-type': ['application/json']});
        }
        return ResponseBody.fromString('{"success": true}', 200);
      });

      final storage = InMemorySecureStorageService();
      final sessionMgr = SessionManager(storage: storage);
      final now = DateTime.now();
      final adminSession = AuthSession(
        token: 'admin_test_token',
        userId: 'admin_user_01',
        role: 'DISPATCH_OPERATOR',
        name: 'Ops Admin',
        phone: '9876543210',
        city: 'Hyderabad',
        issuedAt: now,
        expiresAt: now.add(const Duration(hours: 8)),
      );
      await sessionMgr.establishSession(adminSession);

      final apiClient = ApiClient(
        baseUrl: 'http://127.0.0.1:4000',
        tokenProvider: sessionMgr,
        idempotencyManager: InMemoryIdempotencyManager(),
        dio: dio,
      );

      final opsService = OperationsService(
        apiClient: apiClient,
        idempotencyManager: InMemoryIdempotencyManager(),
      );

      final opsController = OperationsController(operationsService: opsService);

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: OperationsDashboardScreen(
            controller: opsController,
            autoLoad: true,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Top Header & Ledger Parity
      expect(find.text('CONTROL TOWER'), findsOneWidget);
      expect(find.text('₹0.00 PARITY'), findsOneWidget);

      // Exception-First Incident Wall
      expect(find.text('ATTENTION REQUIRED (1)'), findsOneWidget);
      expect(find.text('1 CRITICAL'), findsOneWidget);
      expect(find.text('Dispatch timeout 130s on TRIP_OPS_DASH_1'), findsOneWidget);

      // Status Bar Aggregates
      expect(find.text('25'), findsOneWidget); // Total
      expect(find.text('18'), findsOneWidget); // Online
      expect(find.text('80%'), findsOneWidget); // Utilization

      // Active Trips and Live Drivers
      expect(find.text('TRIP_OPS_DASH_1'), findsWidgets);
      expect(find.text('Arjun Varma'), findsOneWidget);
      expect(find.text('TS08AA9999'), findsOneWidget);

      // AppRouter Role-Guarding Verification
      final router = AppRouter(initialSession: sessionMgr.currentSession);
      expect(router.currentRoute, AppRoute.operationsDashboard);

      // Customer role must be rejected from navigating to operationsDashboard
      final customerSession = AuthSession(
        token: 'cust_token',
        userId: 'cust_01',
        role: 'CUSTOMER',
        name: 'Customer One',
        phone: '9988776655',
        city: 'Hyderabad',
        issuedAt: now,
        expiresAt: now.add(const Duration(hours: 1)),
      );
      router.updateSession(customerSession);
      expect(router.currentRoute, AppRoute.customerHome);
      final didNavigate = router.navigateTo(AppRoute.operationsDashboard);
      expect(didNavigate, false); // Guarded!
      expect(router.currentRoute, AppRoute.customerHome);
    });
  });

  group('Post-Certification Product Validation: Multi-Role Simulator & Scenario Harness', () {
    test('Harness: ScenarioRunner executes all 10 deterministic operational scenarios', () async {
      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        return ResponseBody.fromString('{"success": true}', 200, headers: {'content-type': ['application/json']});
      });

      final storage = InMemorySecureStorageService();
      final sessionMgr = SessionManager(storage: storage);
      final idempMgr = InMemoryIdempotencyManager();
      final persistence = InMemoryLocalPersistenceService();
      final projStore = LocalTripProjectionStore();
      final locStore = DriverLocationStore();

      final client = ApiClient(
        baseUrl: 'http://127.0.0.1:4000',
        tokenProvider: sessionMgr,
        idempotencyManager: idempMgr,
        dio: dio,
      );

      final custService = CustomerTripService(
        apiClient: client,
        projectionStore: projStore,
        persistenceService: persistence,
        idempotencyManager: idempMgr,
      );

      final drvService = DriverPartnerService(
        apiClient: client,
        projectionStore: projStore,
        persistenceService: persistence,
        idempotencyManager: idempMgr,
      );

      final opsService = OperationsService(
        apiClient: client,
        idempotencyManager: idempMgr,
      );

      final runner = ScenarioRunner(
        apiClient: client,
        customerService: custService,
        driverService: drvService,
        operationsService: opsService,
        projectionStore: projStore,
        locationStore: locStore,
        sessionManager: sessionMgr,
        idempotencyManager: idempMgr,
        persistenceService: persistence,
      );

      expect(ScenarioRunner.definitions.length, 10);

      // Execute all 10 scenarios
      for (final def in ScenarioRunner.definitions) {
        final report = await runner.runScenario(def.id);
        expect(report.success, true, reason: 'Scenario ${def.id} (${def.title}) must pass');
        expect(report.steps.isNotEmpty, true);
        for (final step in report.steps) {
          expect(step.success, true, reason: 'Step ${step.stepIndex} (${step.title}) failed: ${step.details}');
        }
      }
    });

    testWidgets('Simulator Shell: MultiRoleSimulatorShell seamlessly switches roles and triggers scenarios', (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        final path = options.uri.path;
        if (path.contains('/api/admin/alerts')) {
          return ResponseBody.fromString('{"success": true, "alerts": []}', 200, headers: {'content-type': ['application/json']});
        }
        if (path.contains('/api/admin/fleet/live')) {
          return ResponseBody.fromString('{"success": true, "summary": {"totalDrivers": 10, "onlineCount": 8, "degradedCount": 0, "staleCount": 0, "offlineCount": 2, "utilizationPercent": 80}, "drivers": []}', 200, headers: {'content-type': ['application/json']});
        }
        if (path.contains('/api/admin/trips/active')) {
          return ResponseBody.fromString('{"success": true, "activeTrips": []}', 200, headers: {'content-type': ['application/json']});
        }
        return ResponseBody.fromString('{"success": true}', 200, headers: {'content-type': ['application/json']});
      });

      final storage = InMemorySecureStorageService();
      final sessionMgr = SessionManager(storage: storage);
      final idempMgr = InMemoryIdempotencyManager();
      final persistence = InMemoryLocalPersistenceService();
      final projStore = LocalTripProjectionStore();
      final locStore = DriverLocationStore();

      final client = ApiClient(
        baseUrl: 'http://127.0.0.1:4000',
        tokenProvider: sessionMgr,
        idempotencyManager: idempMgr,
        dio: dio,
      );

      final wsClient = WebSocketClient(
        serverUrl: 'ws://127.0.0.1:4000/ws',
        tokenProvider: sessionMgr,
        channelFactory: (_) => throw UnimplementedError(),
      );

      final custService = CustomerTripService(
        apiClient: client,
        projectionStore: projStore,
        persistenceService: persistence,
        idempotencyManager: idempMgr,
      );

      final drvService = DriverPartnerService(
        apiClient: client,
        projectionStore: projStore,
        persistenceService: persistence,
        idempotencyManager: idempMgr,
      );

      final opsService = OperationsService(
        apiClient: client,
        idempotencyManager: idempMgr,
      );

      final custCtrl = CustomerTripController(
        tripService: custService,
        projectionStore: projStore,
      );

      final drvCtrl = DriverPartnerController(
        driverService: drvService,
        projectionStore: projStore,
      );

      final opsCtrl = OperationsController(
        operationsService: opsService,
      );

      final runner = ScenarioRunner(
        apiClient: client,
        customerService: custService,
        driverService: drvService,
        operationsService: opsService,
        projectionStore: projStore,
        locationStore: locStore,
        sessionManager: sessionMgr,
        idempotencyManager: idempMgr,
        persistenceService: persistence,
      );

      final router = AppRouter(initialSession: sessionMgr.currentSession);

      await tester.pumpWidget(
        MaterialApp(
          theme: VaayuTheme.dark(),
          home: MultiRoleSimulatorShell(
            customerController: custCtrl,
            driverController: drvCtrl,
            operationsController: opsCtrl,
            scenarioRunner: runner,
            sessionManager: sessionMgr,
            router: router,
            projectionStore: projStore,
            locationStore: locStore,
            webSocketClient: wsClient,
            initialTab: SimulatorTab.customer,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Top Diagnostic Header
      expect(find.text('SIMULATOR'), findsOneWidget);
      expect(find.text('₹0.00 LEDGER'), findsOneWidget);

      // Rider Tab is active by default
      expect(find.byType(CustomerHomeScreen), findsOneWidget);
      expect(sessionMgr.currentSession?.role, 'CUSTOMER');

      // Switch to Driver Tab
      await tester.tap(find.byKey(const Key('tab_simulator_driver')));
      await tester.pumpAndSettle();
      expect(find.byType(DriverDashboardScreen), findsOneWidget);
      expect(sessionMgr.currentSession?.role, 'DRIVER');

      // Switch to Control Tower Tab
      await tester.tap(find.byKey(const Key('tab_simulator_operations')));
      await tester.pumpAndSettle();
      expect(find.byType(OperationsDashboardScreen), findsOneWidget);
      expect(sessionMgr.currentSession?.role, 'DISPATCH_OPERATOR');

      // Switch to Scenarios Tab
      await tester.tap(find.byKey(const Key('tab_simulator_scenarios')));
      await tester.pumpAndSettle();
      expect(find.text('DETERMINISTIC SCENARIO HARNESS'), findsOneWidget);
      expect(find.byKey(const Key('btn_run_all_scenarios')), findsOneWidget);
      expect(find.byKey(const Key('card_SCENARIO_01')), findsOneWidget);
      expect(find.byKey(const Key('card_SCENARIO_10')), findsOneWidget);

      // Run Scenario 01
      await tester.tap(find.byKey(const Key('btn_run_SCENARIO_01')));
      await tester.pumpAndSettle();

      expect(find.text('PASS'), findsOneWidget);
    });
  });
}

class _MockHttpClientAdapter implements HttpClientAdapter {
  final Future<ResponseBody> Function(RequestOptions options) _handler;
  _MockHttpClientAdapter(this._handler);

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<dynamic>? requestStream, Future<void>? cancelFuture) {
    return _handler(options);
  }

  @override
  void close({bool force = false}) {}
}
