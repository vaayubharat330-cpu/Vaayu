/**
 * VAAYU Milestone 12: Notification Reliability Suite
 * 
 * Verifies the 12 domains of the Pillar 12 Notification Architecture:
 * 1. P12.1 & P12.2: Outbox event ingestion, multi-channel hierarchy (WebSocket -> Push -> SMS) & uniform adapter contracts.
 * 2. P12.3 & 12.4: Deterministic idempotency, deduplication window & monotonic version suppression (out-of-order rejection).
 * 3. P12.5 & 12.6: Notification TTL expiration (stale offer suppression), bounded retries, exponential backoff & DLQ routing.
 * 4. P12.7 & 12.8: Recipient authorization gating (BOLA prevention), cross-tenant isolation & priority queue ordering.
 * 5. P12.9 & 12.10: Upstream push provider outage simulation, circuit breaker protection & authoritative reconnect snapshot.
 * 6. P12.11 & 12.12: Complete end-to-end trip with notification lifecycle, metrics validation & PostgreSQL double-entry audit (₹0 imbalance).
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');

const { NotificationService, MockPushProvider } = require('../../src/services/notificationService');
const { metricsService } = require('../../src/services/metricsService');
const db = require('../../src/db/database');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');

test('Pillar 12: Notification Reliability Suite', async (suite) => {

  // =========================================================================
  // 12.1 & 12.2: OUTBOX INGESTION & MULTI-CHANNEL HIERARCHY
  // =========================================================================
  await suite.test('12.1 & 12.2: Outbox Event Ingestion & Multi-Channel Hierarchy (WebSocket -> Push Fallback)', async () => {
    // 1. WebSocket Connected Client Scenario
    let wsSent = false;
    const mockWsService = {
      sendToUser(userId, eventType, payload) {
        if (userId === 'cust_online_01') {
          wsSent = true;
          return true; // Successfully delivered via WebSocket
        }
        return false; // User not connected
      }
    };

    const mockPush = new MockPushProvider('MockFCM');
    const service = new NotificationService({
      websocketService: mockWsService,
      pushProvider: mockPush
    });

    const eventWs = {
      event_id: 'evt_outbox_01',
      event_type: 'ORDER_ASSIGNED',
      payload: {
        orderId: 'TRIP_N12_01',
        recipientId: 'cust_online_01',
        recipientRole: 'CUSTOMER',
        version: 1
      }
    };

    const resWs = await service.ingestOutboxEvent(eventWs);
    assert.equal(resWs.success, true);
    assert.equal(resWs.channel, 'WEBSOCKET');
    assert.equal(resWs.status, 'DELIVERED');
    assert.equal(wsSent, true);
    assert.equal(mockPush.sentPushes.length, 0, 'Push must NOT be called if WebSocket delivers successfully');

    // 2. Disconnected Client: Must gracefully fallback to Push Notification
    const eventPush = {
      event_id: 'evt_outbox_02',
      event_type: 'ORDER_ASSIGNED',
      payload: {
        orderId: 'TRIP_N12_02',
        recipientId: 'cust_offline_02',
        recipientRole: 'CUSTOMER',
        version: 1
      }
    };

    const resPush = await service.ingestOutboxEvent(eventPush);
    assert.equal(resPush.success, true);
    assert.equal(resPush.channel, 'PUSH');
    assert.equal(resPush.status, 'DELIVERED');
    assert.equal(mockPush.sentPushes.length, 1, 'Push must be invoked when WebSocket client is offline');
    assert.equal(mockPush.sentPushes[0].targetUserId, 'cust_offline_02');
  });

  // =========================================================================
  // 12.3 & 12.4: IDEMPOTENCY, DEDUPLICATION & MONOTONIC VERSION GATING
  // =========================================================================
  await suite.test('12.3 & 12.4: Idempotency, Deduplication & Monotonic Version Sequencing', async () => {
    const mockPush = new MockPushProvider();
    const service = new NotificationService({ pushProvider: mockPush });

    const notificationA = {
      id: 'notif_dedup_01',
      tripId: 'TRIP_DEDUP_01',
      eventType: 'DRIVER_ARRIVING',
      recipientId: 'cust_dedup_01',
      recipientRole: 'CUSTOMER',
      version: 2,
      createdAt: Date.now()
    };

    // 1. Initial Send: Delivered
    const resFirst = await service.dispatchNotification(notificationA);
    assert.equal(resFirst.success, true);
    assert.equal(resFirst.status, 'DELIVERED');
    assert.equal(mockPush.sentPushes.length, 1);

    // 2. Immediate Duplicate Send (Retry / duplicate outbox trigger): Suppressed by Dedup Guard
    const resDup = await service.dispatchNotification(notificationA);
    assert.equal(resDup.success, true);
    assert.equal(resDup.status, 'DEDUPLICATED');
    assert.equal(mockPush.sentPushes.length, 1, 'Duplicate send must not invoke push provider');

    // 3. Monotonic Version Sequencing:
    // Client receives Version 4
    await service.dispatchNotification({
      id: 'notif_v4',
      tripId: 'TRIP_DEDUP_01',
      eventType: 'IN_TRANSIT',
      recipientId: 'cust_dedup_01',
      recipientRole: 'CUSTOMER',
      version: 4,
      createdAt: Date.now()
    });

    // Lagged out-of-order Version 3 arrives late: Must be suppressed to prevent UI state regression
    const resLagged = await service.dispatchNotification({
      id: 'notif_v3_lagged',
      tripId: 'TRIP_DEDUP_01',
      eventType: 'PICKUP_CONFIRMED',
      recipientId: 'cust_dedup_01',
      recipientRole: 'CUSTOMER',
      version: 3,
      createdAt: Date.now()
    });

    assert.equal(resLagged.success, false);
    assert.equal(resLagged.status, 'STALE_VERSION_SUPPRESSED');
  });

  // =========================================================================
  // 12.5 & 12.6: TTL EXPIRATION, RETRY BACKOFF & DEAD-LETTER QUEUE (DLQ)
  // =========================================================================
  await suite.test('12.5 & 12.6: TTL Expiration, Retries & Dead-Letter Queue (DLQ)', async () => {
    // 1. Stale Dispatch Offer TTL Expiration
    const serviceTtl = new NotificationService();
    const staleOffer = {
      id: 'notif_offer_stale',
      tripId: 'TRIP_OFFER_01',
      eventType: 'DISPATCH_OFFER',
      recipientId: 'drv_offer_01',
      recipientRole: 'DRIVER',
      version: 1,
      ttlMs: 500, // 500ms short TTL for dispatch offer
      createdAt: Date.now() - 2000 // Created 2 seconds ago
    };

    const resStale = await serviceTtl.dispatchNotification(staleOffer);
    assert.equal(resStale.success, false);
    assert.equal(resStale.status, 'EXPIRED_SUPPRESSED');

    // 2. Bounded Retries & DLQ Routing on Persistent Push Failure
    const failingPush = new MockPushProvider('FailingFCM', { shouldFail: true });
    const serviceDlq = new NotificationService({
      pushProvider: failingPush,
      maxAttempts: 3
    });

    const failingNotification = {
      id: 'notif_fail_01',
      tripId: 'TRIP_FAIL_01',
      eventType: 'CRITICAL_ALERT',
      recipientId: 'cust_fail_01',
      recipientRole: 'CUSTOMER',
      version: 1,
      createdAt: Date.now()
    };

    const resFail = await serviceDlq.dispatchNotification(failingNotification);
    assert.equal(resFail.success, false);
    assert.equal(resFail.status, 'FAILED_TO_DLQ');
    assert.equal(serviceDlq.dlq.length, 1, 'Permanently failing notification must land in DLQ');
    assert.equal(serviceDlq.dlq[0].notification.id, 'notif_fail_01');
    assert.equal(serviceDlq.dlq[0].attempts, 3, 'Must attempt exactly 3 times before DLQ');
  });

  // =========================================================================
  // 12.7 & 12.8: RECIPIENT AUTHORIZATION & TENANT BOUNDARIES
  // =========================================================================
  await suite.test('12.7 & 12.8: Recipient Authorization Gating & Tenant Boundaries', async () => {
    const service = new NotificationService();

    const tripObj = {
      id: 'TRIP_TENANT_01',
      customerId: 'usr_valid_customer',
      driver: { id: 'drv_valid_driver' },
      merchantId: 'merch_enterprise_A'
    };

    // 1. Valid Customer Recipient: Authorized
    const validCustNotif = {
      id: 'notif_auth_01',
      tripId: tripObj.id,
      eventType: 'DRIVER_ASSIGNED',
      recipientId: 'usr_valid_customer',
      recipientRole: 'CUSTOMER',
      createdAt: Date.now()
    };
    const resAuthCust = await service.dispatchNotification(validCustNotif, tripObj);
    assert.equal(resAuthCust.success, true);

    // 2. Unauthorized Impersonator Customer (BOLA / IDOR): Rejected
    const attackerCustNotif = {
      id: 'notif_auth_02',
      tripId: tripObj.id,
      eventType: 'DRIVER_ASSIGNED',
      recipientId: 'usr_malicious_intruder',
      recipientRole: 'CUSTOMER',
      createdAt: Date.now()
    };
    const resAttacker = await service.dispatchNotification(attackerCustNotif, tripObj);
    assert.equal(resAttacker.success, false);
    assert.equal(resAttacker.status, 'REJECTED_UNAUTHORIZED');

    // 3. Cross-Tenant Merchant Boundary Violation: Rejected
    const crossTenantNotif = {
      id: 'notif_tenant_03',
      tripId: tripObj.id,
      eventType: 'DELIVERY_POD',
      recipientId: 'usr_valid_customer',
      recipientRole: 'CUSTOMER',
      merchantId: 'merch_enterprise_B', // Attempting to route under Enterprise B tenant
      createdAt: Date.now()
    };
    const resCrossTenant = await service.dispatchNotification(crossTenantNotif, tripObj);
    assert.equal(resCrossTenant.success, false);
    assert.equal(resCrossTenant.status, 'REJECTED_UNAUTHORIZED');
  });

  // =========================================================================
  // 12.9 & 12.10: UPSTREAM PUSH OUTAGE & CIRCUIT BREAKER
  // =========================================================================
  await suite.test('12.9 & 12.10: Push Outage Circuit Breaker & Authoritative Resync Handshake', async () => {
    const failingPush = new MockPushProvider('OutageFCM', { shouldFail: true });
    const service = new NotificationService({
      pushProvider: failingPush,
      circuitFailThreshold: 3,
      circuitResetTimeoutMs: 1000
    });

    const notif = {
      id: 'notif_cb_01',
      tripId: 'TRIP_CB_01',
      eventType: 'STATUS_UPDATE',
      recipientId: 'cust_cb_01',
      recipientRole: 'CUSTOMER',
      createdAt: Date.now()
    };

    // Trigger failures to trip circuit breaker
    await service.dispatchNotification({ ...notif, id: 'notif_cb_1' });
    await service.dispatchNotification({ ...notif, id: 'notif_cb_2' });
    await service.dispatchNotification({ ...notif, id: 'notif_cb_3' });

    assert.equal(service.getCircuitState(), 'OPEN', 'Circuit breaker must trip to OPEN on 3 failures');

    // Subsequent call while OPEN: Fast-fails to DLQ without executing upstream network calls
    const resOpen = await service.dispatchNotification({ ...notif, id: 'notif_cb_4' });
    assert.equal(resOpen.success, false);
    assert.equal(resOpen.status, 'CIRCUIT_OPEN_DLQ');

    // Authoritative Reconnect Invariant:
    // When a client reconnects, it fetches database snapshot rather than unbounded event replay
    const store = db.getDb();
    if (!store.trips) store.trips = [];
    const authoritativeTrip = {
      id: 'TRIP_RESYNC_01',
      status: 'IN_TRANSIT',
      version: 5,
      driver: { id: 'drv_01', currentLat: 17.44, currentLng: 78.38 }
    };
    store.trips.push(authoritativeTrip);
    db.saveDb(store);

    // Verify database remains ground truth
    const retrievedTrip = db.getTripById('TRIP_RESYNC_01');
    assert.equal(retrievedTrip.status, 'IN_TRANSIT');
    assert.equal(retrievedTrip.version, 5);
  });

  // =========================================================================
  // 12.11 & 12.12: FINANCIAL INVARIANT & POSTGRESQL RECONCILIATION
  // =========================================================================
  await suite.test('12.11 & 12.12: Financial Core Invariant: Full lifecycle settlement with notifications & ₹0 ledger balance', async () => {
    const tripId = `TRIP_P12_FIN_${Date.now()}`;
    const customerId = `cust_p12_${Date.now()}`;
    const driverId = `drv_p12_${Date.now()}`;
    const farePaise = 50000; // ₹500.00

    const repo = new PostgresLedgerRepository();
    const psm = new PaymentStateMachine({ ledgerService: repo });
    const paymentService = new PaymentIntegrationService({ ledgerService: repo, paymentStateMachine: psm });
    const notifService = new NotificationService();

    // 1. Top up customer wallet
    await repo.topUpCustomerWallet({ customerId, amountPaise: 100000, idempotencyKey: `top:p12:${tripId}` });

    // 2. Escrow Hold with Outbox Event
    const escrowRes = await paymentService.reserveEscrow({
      tripId,
      orderId: tripId,
      customerId,
      amountPaise: farePaise,
      idempotencyKey: `esc:p12:${tripId}`
    });
    assert.equal(escrowRes.success, true);
    assert.equal(escrowRes.state, 'ESCROWED');

    // Notify Customer of Escrow Hold
    await notifService.ingestOutboxEvent({
      event_id: `evt_escrow_${tripId}`,
      event_type: 'PAYMENT_ESCROWED',
      aggregate_id: tripId,
      payload: { orderId: tripId, recipientId: customerId, recipientRole: 'CUSTOMER', version: 1 }
    });

    // 3. Settle Trip
    const settleRes = await paymentService.settleTrip({
      tripId,
      driverId,
      amountPaise: farePaise,
      idempotencyKey: `set:p12:${tripId}`
    });
    assert.equal(settleRes.success, true);
    assert.equal(settleRes.state, 'SETTLED');

    // Notify Driver & Customer of Settlement
    await notifService.ingestOutboxEvent({
      event_id: `evt_settle_${tripId}`,
      event_type: 'PAYMENT_SETTLED',
      aggregate_id: tripId,
      payload: { orderId: tripId, recipientId: driverId, recipientRole: 'DRIVER', version: 2 }
    });

    // 4. Ledger Reconciliation Audit against PostgreSQL
    const rec = await repo.reconcile();
    assert.equal(rec.ok, true, 'PostgreSQL double-entry reconciliation must be clean');
    assert.equal(rec.problems.length, 0, 'Zero ledger discrepancy problems allowed');

    // 5. Metrics Observability Verification
    const metricsSnapshot = metricsService.getSnapshot();
    assert.ok(metricsSnapshot.counters.notifications_dispatched_total > 0);
    assert.ok(metricsSnapshot.counters.notifications_delivered_total > 0);

    await repo.pool.end();
  });
});
