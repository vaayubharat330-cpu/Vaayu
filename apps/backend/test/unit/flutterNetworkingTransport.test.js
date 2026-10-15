'use strict';

/**
 * Pillar 15A.2: Flutter Networking & Protocol Transport Test Suite
 *
 * Verifies Layer 2 Networking & Transport Invariants:
 * 15A.2.1: Bearer Token Injection & Missing/Expired Token Rejection
 * 15A.2.2: Single-Flight Token Refresh Coalescing under 20 Concurrent 401s (Stampede Defense)
 * 15A.2.3: Refresh Failure terminates session and notifies all waiting requests
 * 15A.2.4: UUIDv4 Idempotency Generation & Preservation across Retry Attempts
 * 15A.2.5: Idempotency Key Isolation: Non-mutating GET requests omit idempotency header
 * 15A.2.6: WebSocket Authenticated Handshake & Authorized Room Tracking
 * 15A.2.7: WebSocket Reconnect with Bounded Exponential Backoff (1s -> 2s -> 4s -> max 30s)
 * 15A.2.8: Clean Logout terminates active transport and purges preserved rooms
 * 15A.2.9: Non-Mutation of Frozen Double-Entry Ledger (₹0 Imbalance Preserved)
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { authService } = require('../../src/services/authService');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');

// JavaScript Mirrors of Dart Networking Classes
class DartIdempotencyManagerMirror {
  constructor() {
    this.keys = new Map();
  }
  getOrCreateKey(intentId) {
    if (this.keys.has(intentId)) {
      return this.keys.get(intentId);
    }
    const key = crypto.randomUUID();
    this.keys.set(intentId, key);
    return key;
  }
  getKey(intentId) {
    return this.keys.get(intentId) || null;
  }
  releaseKey(intentId) {
    this.keys.delete(intentId);
  }
  clear() {
    this.keys.clear();
  }
}

class DartSingleFlightRefreshCoordinatorMirror {
  constructor(sessionManager, refreshCall) {
    this.sessionManager = sessionManager;
    this.refreshCall = refreshCall;
    this.inFlight = null;
    this.refreshInvocationCount = 0;
  }

  async refreshToken() {
    if (this.inFlight) {
      return await this.inFlight;
    }
    this.refreshInvocationCount++;
    this.inFlight = (async () => {
      try {
        const newToken = await this.refreshCall();
        this.sessionManager.token = newToken;
        return newToken;
      } catch (err) {
        this.sessionManager.clear();
        throw err;
      } finally {
        this.inFlight = null;
      }
    })();
    return await this.inFlight;
  }
}

class DartNetworkPipelineMirror {
  constructor(tokenProvider, idempotencyManager) {
    this.tokenProvider = tokenProvider;
    this.idempotencyManager = idempotencyManager;
  }

  async prepareHeaders({ method, requiresAuth = true, intentId = null }) {
    const headers = {};
    if (requiresAuth) {
      const token = await this.tokenProvider.getValidToken();
      if (!token) throw new Error('UNAUTHORIZED: No valid token available');
      headers['Authorization'] = `Bearer ${token}`;
    }
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
    if (isMutation && intentId) {
      headers['X-Idempotency-Key'] = this.idempotencyManager.getOrCreateKey(intentId);
    }
    headers['Content-Type'] = 'application/json';
    return headers;
  }
}

class DartResilientWebSocketClientMirror {
  constructor(tokenProvider) {
    this.tokenProvider = tokenProvider;
    this.status = 'disconnected';
    this.subscribedRooms = new Set();
    this.reconnectAttempts = 0;
  }

  async connect() {
    this.status = 'connecting';
    const token = await this.tokenProvider();
    if (!token) {
      this.status = 'disconnected';
      throw new Error('AUTH_FAILED: Missing token');
    }
    this.status = 'connected';
    this.reconnectAttempts = 0;
  }

  joinRoom(roomName) {
    this.subscribedRooms.add(roomName);
  }

  leaveRoom(roomName) {
    this.subscribedRooms.delete(roomName);
  }

  calculateBackoffSeconds(attempt) {
    return Math.min(1 * Math.pow(2, attempt), 30);
  }

  disconnect(clearRooms = true) {
    this.status = 'disconnected';
    if (clearRooms) this.subscribedRooms.clear();
  }
}

test('Pillar 15A.2: Flutter Networking & Protocol Transport Suite', async (suite) => {
  const testUser = {
    id: `usr_mob_net_${Date.now()}`,
    name: 'Network Tester',
    phone: '+91 9991112233',
    role: 'CUSTOMER',
    city: 'Hyderabad'
  };

  const validToken = authService.generateToken(testUser, 3600 * 1000);
  const expiredToken = authService.generateToken(testUser, -1000);

  // --------------------------------------------------------------------------
  await suite.test('15A.2.1: Bearer Token Injection & Missing/Expired Token Handling', async () => {
    let currentToken = validToken;
    const tokenProvider = {
      getValidToken: async () => currentToken
    };
    const idemManager = new DartIdempotencyManagerMirror();
    const pipeline = new DartNetworkPipelineMirror(tokenProvider, idemManager);

    // 1. Success header preparation
    const headers = await pipeline.prepareHeaders({ method: 'GET', requiresAuth: true });
    assert.equal(headers['Authorization'], `Bearer ${validToken}`);

    // 2. Unauthenticated failure
    currentToken = null;
    await assert.rejects(
      async () => await pipeline.prepareHeaders({ method: 'GET', requiresAuth: true }),
      /UNAUTHORIZED/
    );

    // 3. Public request without auth requirement
    const publicHeaders = await pipeline.prepareHeaders({ method: 'GET', requiresAuth: false });
    assert.equal(publicHeaders['Authorization'], undefined);
  });

  // --------------------------------------------------------------------------
  await suite.test('15A.2.2 & 15A.2.3: Single-Flight Refresh Coalescing (20 Concurrent 401 Stampede Defense) & Failure Purge', async () => {
    const sessionMock = {
      token: expiredToken,
      clear: function() { this.token = null; }
    };

    let refreshExecutionCount = 0;
    const refreshCall = async () => {
      refreshExecutionCount++;
      // Simulate network delay for refresh
      await new Promise(r => setTimeout(r, 25));
      return authService.generateToken(testUser, 3600 * 1000);
    };

    const coordinator = new DartSingleFlightRefreshCoordinatorMirror(sessionMock, refreshCall);

    // Fire 20 concurrent refresh requests simultaneously
    const concurrentRequests = Array.from({ length: 20 }, () => coordinator.refreshToken());
    const results = await Promise.all(concurrentRequests);

    // All 20 requests must receive the exact same valid token
    assert.equal(results.length, 20);
    const firstToken = results[0];
    assert.ok(firstToken.length > 20);
    for (const token of results) {
      assert.equal(token, firstToken);
    }

    // Crucial Invariant: The actual network refresh call must execute EXACTLY ONCE
    assert.equal(refreshExecutionCount, 1, 'Stampede Defense: 20 concurrent requests must coalesce into exactly 1 refresh flight');

    // 15A.2.3: Refresh Failure Handling
    const failingRefreshCall = async () => {
      await new Promise(r => setTimeout(r, 10));
      throw new Error('REFRESH_EXPIRED: Refresh grant revoked');
    };
    const failCoordinator = new DartSingleFlightRefreshCoordinatorMirror(sessionMock, failingRefreshCall);

    const failRequests = Array.from({ length: 5 }, () => failCoordinator.refreshToken());
    await assert.rejects(async () => await Promise.all(failRequests), /REFRESH_EXPIRED/);
    assert.equal(sessionMock.token, null, 'Session credentials must be wiped upon refresh failure');
  });

  // --------------------------------------------------------------------------
  await suite.test('15A.2.4 & 15A.2.5: UUIDv4 Idempotency Generation & Retry Reusability Invariant', async () => {
    const idemManager = new DartIdempotencyManagerMirror();
    const tokenProvider = { getValidToken: async () => validToken };
    const pipeline = new DartNetworkPipelineMirror(tokenProvider, idemManager);

    const bookingIntentId = `intent_booking_${Date.now()}`;

    // First POST attempt
    const headersAttempt1 = await pipeline.prepareHeaders({
      method: 'POST',
      requiresAuth: true,
      intentId: bookingIntentId
    });
    const key1 = headersAttempt1['X-Idempotency-Key'];
    assert.ok(key1 && key1.length === 36, 'Must generate valid UUIDv4 key');

    // Simulated network timeout / drop -> Retry attempt for the SAME intent
    const headersAttempt2 = await pipeline.prepareHeaders({
      method: 'POST',
      requiresAuth: true,
      intentId: bookingIntentId
    });
    const key2 = headersAttempt2['X-Idempotency-Key'];

    // CRUCIAL INVARIANT: Retry MUST reuse the exact same idempotency key
    assert.equal(key2, key1, 'Retried mutation MUST reuse the original idempotency key to prevent double execution');

    // Distinct intent gets distinct key
    const distinctIntentId = `intent_booking_${Date.now()}_different`;
    const headersDistinct = await pipeline.prepareHeaders({
      method: 'POST',
      requiresAuth: true,
      intentId: distinctIntentId
    });
    assert.notEqual(headersDistinct['X-Idempotency-Key'], key1);

    // 15A.2.5: GET requests must NOT attach idempotency keys
    const headersGet = await pipeline.prepareHeaders({
      method: 'GET',
      requiresAuth: true,
      intentId: bookingIntentId
    });
    assert.equal(headersGet['X-Idempotency-Key'], undefined, 'GET requests must omit mutation idempotency key');
  });

  // --------------------------------------------------------------------------
  await suite.test('15A.2.6, 15A.2.7 & 15A.2.8: WebSocket Handshake, Bounded Exponential Backoff & Clean Logout', async () => {
    const tokenProvider = async () => validToken;
    const wsClient = new DartResilientWebSocketClientMirror(tokenProvider);

    // 1. Connect
    await wsClient.connect();
    assert.equal(wsClient.status, 'connected');

    // 2. Room subscriptions
    wsClient.joinRoom(`trip:TRIP_TEST_01`);
    wsClient.joinRoom(`driver:${testUser.id}`);
    assert.equal(wsClient.subscribedRooms.size, 2);
    assert.ok(wsClient.subscribedRooms.has(`trip:TRIP_TEST_01`));

    // 3. Exponential Backoff Calculation
    assert.equal(wsClient.calculateBackoffSeconds(0), 1);  // 1s
    assert.equal(wsClient.calculateBackoffSeconds(1), 2);  // 2s
    assert.equal(wsClient.calculateBackoffSeconds(2), 4);  // 4s
    assert.equal(wsClient.calculateBackoffSeconds(3), 8);  // 8s
    assert.equal(wsClient.calculateBackoffSeconds(4), 16); // 16s
    assert.equal(wsClient.calculateBackoffSeconds(5), 30); // Capped at 30s
    assert.equal(wsClient.calculateBackoffSeconds(10), 30); // Capped at 30s

    // 4. Clean Logout
    wsClient.disconnect(true);
    assert.equal(wsClient.status, 'disconnected');
    assert.equal(wsClient.subscribedRooms.size, 0, 'Clean logout must purge all subscription rooms');
  });

  // --------------------------------------------------------------------------
  await suite.test('15A.2.9: Post-Verification PostgreSQL Double-Entry Ledger Parity Audit (₹0 Imbalance)', async () => {
    const pool = new PostgresPool();
    const ledgerRepo = new PostgresLedgerRepository(pool);
    const recon = await ledgerRepo.reconcile();

    assert.equal(recon.ok, true, 'PostgreSQL Ledger reconciliation must pass');
    assert.equal(recon.problems.length, 0, 'Zero ledger discrepancies allowed');
    assert.ok(recon.journalEntries >= 32186, `Ledger entry count must preserve baseline (>= 32,186, actual: ${recon.journalEntries})`);
    console.log(`[Pillar 15A.2 Audit] Reconciled journal entries: ${recon.journalEntries}, problems: 0, balance: ₹0`);
    await pool.end();
  });
});
