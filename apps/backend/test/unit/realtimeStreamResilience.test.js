'use strict';
/**
 * Pillar 8: Realtime Reliability & Stream Resilience Test Suite
 *
 * Verifies:
 * 1. P8.1 Connection Lifecycle:
 *    - Heartbeat ping/pong and idle tracking
 *    - Ghost connection detection and automatic reaping
 *    - Clean disconnect and room membership evacuation
 *    - Duplicate session arbitration (superseding stale sessions)
 * 2. P8.2 Redis Pub/Sub Resilience:
 *    - Multi-node cross-instance event broadcast fan-out
 *    - Publisher failure fail-open isolation (no blocking of storage)
 *    - Zero cross-tenant / cross-room event leakage
 * 3. P8.3 Slow Consumer / Backpressure:
 *    - Bounded send buffer enforcement
 *    - Selective drop policy for high-frequency telemetry under pressure
 *    - Protection of critical lifecycle events (never silently dropped)
 *    - Slow consumer eviction without degrading healthy peers
 * 4. P8.4 Reconnect Authoritative State Recovery:
 *    - In-transit disconnect simulation
 *    - State synchronization from durable source of truth (PostgreSQL / DB)
 *    - Continued trip completion & ₹0 double-entry ledger balance
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { WebSocketService } = require('../../src/services/websocketService');
const { RedisPubSubManager } = require('../../src/services/redisPubSub');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const { deliveryStateMachine, DELIVERY_STATES } = require('../../src/services/deliveryStateMachine');
const db = require('../../src/db/database');

/**
 * Mock WebSocket Socket Adapter
 */
function createMockSocket(options = {}) {
  const messages = [];
  let isClosed = false;
  let closeCode = null;
  let closeReason = null;
  let pingsReceived = 0;
  let bufferedBytes = options.initialBufferedAmount || 0;

  return {
    send(data) {
      if (isClosed) throw new Error('Cannot send on closed socket');
      messages.push(typeof data === 'string' ? JSON.parse(data) : data);
    },
    close(code = 1000, reason = '') {
      isClosed = true;
      closeCode = code;
      closeReason = reason;
    },
    ping() {
      pingsReceived++;
    },
    get bufferedAmount() {
      return bufferedBytes;
    },
    setBufferedAmount(bytes) {
      bufferedBytes = bytes;
    },
    getMessages: () => messages,
    isClosed: () => isClosed,
    getCloseCode: () => closeCode,
    getCloseReason: () => closeReason,
    getPingsReceived: () => pingsReceived
  };
}

test('Pillar 8: Realtime Reliability & Stream Resilience Verification', async (suite) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  const pool = new PostgresPool({ connectionString, max: 10 });
  const repo = new PostgresLedgerRepository(pool);
  const psm = new PaymentStateMachine({ ledgerService: repo });
  const integrationService = new PaymentIntegrationService({ ledgerService: repo, paymentStateMachine: psm });

  suite.before(async () => {
    await repo.ensureAccount('cash:external', 'ASSET', 'DEBIT');
    await repo.ensureAccount('escrow:platform', 'LIABILITY', 'CREDIT');
    await repo.ensureAccount('platform:commission', 'REVENUE', 'CREDIT');
    await repo.ensureAccount('platform:gst', 'LIABILITY', 'CREDIT');
    await repo.ensureAccount('payout:clearing', 'LIABILITY', 'CREDIT');
  });

  suite.after(async () => {
    await new Promise(r => setTimeout(r, 100));
    await pool.end();
  });

  // =========================================================================
  // 8.1 CONNECTION LIFECYCLE & GHOST SOCKET REAPING
  // =========================================================================
  await suite.test('8.1: Connection Lifecycle: Ping/pong tracking, ghost socket reaping, room cleanup & session deduplication', async () => {
    const wsService = new WebSocketService(null, {
      heartbeatTimeoutMs: 200,
      heartbeatIntervalMs: 50
    });

    try {
      const socket1 = createMockSocket();
      const clientId1 = wsService.registerClient(socket1, 'DRIVER', 'drv_life_01', 'DRIVER');
      assert.ok(wsService.clients.has(clientId1), 'Client 1 must be registered');
      const joinRes = wsService.joinRoom(clientId1, 'driver:drv_life_01');
      assert.equal(joinRes.success, true);
      assert.ok(wsService.rooms.get('driver:drv_life_01').has(clientId1));
      const pingOk = wsService.recordPing(clientId1);
      assert.equal(pingOk, true, 'Ping update must succeed');
      await new Promise(r => setTimeout(r, 260));
      assert.equal(socket1.isClosed(), true, 'Ghost socket must be closed by reaper');
      assert.equal(socket1.getCloseCode(), 1001, 'Close code must indicate heartbeat timeout');
      assert.ok(!wsService.clients.has(clientId1), 'Ghost client must be unregistered');
      assert.ok(!wsService.rooms.has('driver:drv_life_01'), 'Empty room must be cleaned up');
      const socketA = createMockSocket();
      const clientIdA = wsService.registerClient(socketA, 'CUSTOMER', 'cust_multi_01', 'CUSTOMER');
      const socketB = createMockSocket();
      const clientIdB = wsService.registerClient(socketB, 'CUSTOMER', 'cust_multi_01', 'CUSTOMER');
      assert.equal(socketA.isClosed(), true, 'Stale session A must be gracefully superseded');
      assert.equal(socketA.getCloseCode(), 1000, 'Superseded close code must be normal closure');
      assert.ok(!wsService.clients.has(clientIdA), 'Client A must be unregistered');
      assert.ok(wsService.clients.has(clientIdB), 'Client B must remain active session');
    } finally {
      if (wsService.heartbeatInterval) clearInterval(wsService.heartbeatInterval);
    }
  });

  // =========================================================================
  // 8.2 REDIS PUB/SUB RESILIENCE & MULTI-NODE BROADCAST
  // =========================================================================
  await suite.test('8.2: Redis Pub/Sub Resilience: Cross-node broadcast fan-out, failure isolation & zero room leakage', async () => {
    const { RedisClient } = require('../../src/services/redisClient');
    const sharedEngine = new RedisClient().engine;
    if (sharedEngine.channels) sharedEngine.channels.clear();

    const pubSubNodeA = new RedisPubSubManager({ nodeId: 'node_alpha' });
    const pubSubNodeB = new RedisPubSubManager({ nodeId: 'node_beta' });

    const wsNodeA = new WebSocketService(pubSubNodeA);
    const wsNodeB = new WebSocketService(pubSubNodeB);

    await wsNodeA.initPubSub();
    await wsNodeB.initPubSub();

    try {
      const socketCustomerA = createMockSocket();
      const clientCustA = wsNodeA.registerClient(socketCustomerA, 'CUSTOMER', 'cust_trip_alpha', 'CUSTOMER');
      wsNodeA.joinRoom(clientCustA, 'customer:cust_trip_alpha');

      const socketCustomerB = createMockSocket();
      const clientCustB = wsNodeB.registerClient(socketCustomerB, 'CUSTOMER', 'cust_trip_beta', 'CUSTOMER');
      wsNodeB.joinRoom(clientCustB, 'customer:cust_trip_beta');

      await wsNodeB.broadcastToRoom('customer:cust_trip_alpha', 'ORDER_ALERT', {
        title: 'Driver Arrived',
        tripId: 'TRIP_NODE_CROSS_01'
      });

      await new Promise(r => setTimeout(r, 60));

      const custAMessages = socketCustomerA.getMessages();
      assert.equal(custAMessages.length, 1, 'Event from Node B must fan out to Node A subscriber');
      assert.equal(custAMessages[0].event, 'ORDER_ALERT');
      assert.equal(custAMessages[0].data.tripId, 'TRIP_NODE_CROSS_01');

      const custBMessages = socketCustomerB.getMessages();
      assert.equal(custBMessages.length, 0, 'Customer B must receive zero events from Customer A room');

      const brokenPubSub = {
        async publish() { throw new Error('Redis connection refused: ECONNREFUSED'); },
        async subscribe() {}
      };
      const wsNodeDegraded = new WebSocketService(brokenPubSub);
      const localSock = createMockSocket();
      const localClient = wsNodeDegraded.registerClient(localSock, 'CUSTOMER', 'cust_local_01', 'CUSTOMER');
      wsNodeDegraded.joinRoom(localClient, 'customer:cust_local_01');
      const delivered = await wsNodeDegraded.broadcastToRoom('customer:cust_local_01', 'STATUS_PING', { ping: true });
      assert.equal(delivered, 1, 'Local delivery must succeed even when Redis pub/sub fails');
      assert.equal(localSock.getMessages().length, 1);
      if (wsNodeDegraded.heartbeatInterval) clearInterval(wsNodeDegraded.heartbeatInterval);
    } finally {
      if (wsNodeA.heartbeatInterval) clearInterval(wsNodeA.heartbeatInterval);
      if (wsNodeB.heartbeatInterval) clearInterval(wsNodeB.heartbeatInterval);
      await Promise.allSettled([
        pubSubNodeA.disconnect(),
        pubSubNodeB.disconnect()
      ]);
    }
  });

  // =========================================================================
  // 8.3 SLOW CONSUMER & BACKPRESSURE PROTECTION
  // =========================================================================
  await suite.test('8.3: Slow Consumer / Backpressure: Bounded send buffer, selective drop of high-frequency pings & slow client eviction', async () => {
    const wsService = new WebSocketService(null, {
      maxBufferedAmountBytes: 32 * 1024
    });

    try {
      const healthySocket = createMockSocket();
      const slowSocket = createMockSocket();
      const healthyId = wsService.registerClient(healthySocket, 'FLEET_ADMIN', 'admin_hyderabad', 'ADMIN');
      const slowId = wsService.registerClient(slowSocket, 'FLEET_ADMIN', 'admin_slow_monitor', 'ADMIN');
      wsService.joinRoom(healthyId, 'fleet:hyderabad');
      wsService.joinRoom(slowId, 'fleet:hyderabad');
      wsService.broadcastToRoomLocal('fleet:hyderabad', 'FLEET_DRIVER_PING', { driverId: 'drv_1', lat: 17.38 });
      assert.equal(healthySocket.getMessages().length, 1);
      assert.equal(slowSocket.getMessages().length, 1);
      slowSocket.setBufferedAmount(64 * 1024);
      wsService.broadcastToRoomLocal('fleet:hyderabad', 'FLEET_DRIVER_PING', { driverId: 'drv_2', lat: 17.39 });
      assert.equal(healthySocket.getMessages().length, 2, 'Healthy client must receive all stream pings');
      assert.equal(slowSocket.getMessages().length, 1, 'Slow client must have telemetry dropped rather than growing buffer');
      const slowClient = wsService.clients.get(slowId);
      assert.equal(slowClient.droppedMessagesCount, 1, 'Dropped count must be tracked');
      assert.equal(slowSocket.isClosed(), false, 'Droppable message should NOT disconnect client yet');
      wsService.broadcastToRoomLocal('fleet:hyderabad', 'delivery:state_changed', {
        orderId: 'ORD_CRITICAL_01',
        toState: 'DELIVERED'
      });
      assert.equal(healthySocket.getMessages().length, 3, 'Healthy client receives critical state event');
      assert.equal(slowSocket.isClosed(), true, 'Slow consumer must be evicted when critical events cannot be buffered');
      assert.equal(slowSocket.getCloseCode(), 1008, 'Close code must indicate backpressure policy violation');
      assert.ok(!wsService.clients.has(slowId), 'Slow client must be evicted from active registry');
    } finally {
      if (wsService.heartbeatInterval) clearInterval(wsService.heartbeatInterval);
    }
  });

  // =========================================================================
  // 8.4 RECONNECT AUTHORITATIVE STATE RECOVERY
  // =========================================================================
  await suite.test('8.4: Reconnect Authoritative State Recovery: Network disconnect in transit, database truth resync & ₹0 ledger balance', async () => {
    const wsService = new WebSocketService(null);
    const tripId = `TRIP_P8_REC_${Date.now()}`;
    const customerId = `cust_p8_${Date.now()}`;
    const driverId = `drv_p8_${Date.now()}`;
    const farePaise = 30000;

    try {
      await repo.topUpCustomerWallet({ customerId, amountPaise: 50000, idempotencyKey: `top:${tripId}` });
      const escRes = await integrationService.reserveEscrow({
        tripId,
        orderId: tripId,
        customerId,
        amountPaise: farePaise,
        idempotencyKey: `esc:${tripId}`
      });
      assert.equal(escRes.success, true);

      const store = db.getDb();
      if (!store.trips) store.trips = [];
      const tripRecord = {
        id: tripId,
        customerId,
        status: DELIVERY_STATES.DRIVER_ASSIGNED,
        version: 1,
        farePaise,
        driver: { id: driverId, name: 'Suresh Kumar' },
        pickupAddress: 'Gachibowli, Hyderabad',
        dropAddress: 'Hitec City, Hyderabad',
        updatedAt: new Date().toISOString()
      };
      store.trips.push(tripRecord);
      db.saveDb(store);

      const driverSocket1 = createMockSocket();
      const clientD1 = wsService.registerClient(driverSocket1, 'DRIVER', driverId, 'DRIVER');
      wsService.joinRoom(clientD1, `driver:${driverId}`);
      wsService.joinRoom(clientD1, `trip:${tripId}`);
      driverSocket1.close(1006, 'Abnormal network closure (tunnel dropped)');
      wsService.unregisterClient(clientD1);
      assert.equal(wsService.clients.has(clientD1), false, 'Driver socket must be unregistered');

      const updatedTrip = store.trips.find(t => t.id === tripId);
      updatedTrip.status = DELIVERY_STATES.IN_TRANSIT;
      updatedTrip.version = 2;
      db.saveDb(store);

      const driverSocket2 = createMockSocket();
      const clientD2 = wsService.registerClient(driverSocket2, 'DRIVER', driverId, 'DRIVER');
      wsService.joinRoom(clientD2, `driver:${driverId}`);
      wsService.joinRoom(clientD2, `trip:${tripId}`);

      const authoritativeState = await wsService.getAuthoritativeActiveTrip(driverId, 'DRIVER');
      assert.ok(authoritativeState, 'Authoritative trip state must be recoverable');
      assert.equal(authoritativeState.id, tripId);
      assert.equal(authoritativeState.status, DELIVERY_STATES.IN_TRANSIT, 'Must recover IN_TRANSIT status missed during disconnect');
      assert.equal(authoritativeState.version, 2);

      authoritativeState.status = DELIVERY_STATES.DELIVERED;
      db.saveDb(store);

      const settleRes = await integrationService.settleTrip({
        tripId,
        driverId,
        idempotencyKey: `set:${tripId}`
      });
      assert.equal(settleRes.success, true);
      assert.equal(settleRes.state, 'SETTLED');

      const recon = await repo.reconcile();
      assert.equal(recon.ok, true, 'Double-entry reconciliation must be 100% OK post-reconnection');
      assert.equal(recon.problems.length, 0, 'Ledger must have zero reconciliation problems (₹0 imbalance)');
    } finally {
      if (wsService.heartbeatInterval) clearInterval(wsService.heartbeatInterval);
    }
  });
});
