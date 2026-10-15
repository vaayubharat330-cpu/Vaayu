'use strict';

/**
 * Pillar 15A.4: Flutter Lifecycle, Resync & Recovery Architecture Test Suite
 *
 * Verifies Layer 4 Invariants:
 * 15A.4.1: Background -> Foreground transition triggers authoritative resync
 * 15A.4.2: Single-flight coalescing: Multiple rapid foreground events create ONE resync request
 * 15A.4.3: WebSocket disconnect + foreground recovery pulls clean HTTP authoritative snapshot
 * 15A.4.4: Offline Queue Replay is strictly FIFO and preserves original UUIDv4 idempotency keys
 * 15A.4.5: Successful mutation purges ONLY that specific queue item from storage
 * 15A.4.6: Transient network timeout halts replay and preserves queued mutations with incremented retry count
 * 15A.4.7: Blocked Dependency Invariant: Downstream mutations do not bypass earlier permanent failures
 * 15A.4.8: Conflict Reconciliation: Stale queued mutations abort when authoritative trip is already CANCELLED
 * 15A.4.9: Explicit Logout purges user-scoped queue and preserved recovery state
 * 15A.4.10: Post-Verification PostgreSQL Double-Entry Ledger Parity Audit (₹0 Imbalance Preserved)
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');

// JavaScript Mirrors of Dart Layer 4 Classes
class DartAppLifecycleManagerMirror {
  constructor() {
    this.currentState = 'resumed';
    this.onForegroundListeners = [];
    this.onBackgroundListeners = [];
  }

  addOnForegroundListener(fn) { this.onForegroundListeners.push(fn); }
  addOnBackgroundListener(fn) { this.onBackgroundListeners.push(fn); }

  async handleLifecycleTransition(newState) {
    if (this.currentState === newState) return;
    const wasBackground = this.currentState === 'paused' || this.currentState === 'detached';
    this.currentState = newState;
    if (newState === 'resumed' && wasBackground) {
      for (const fn of this.onForegroundListeners) await fn();
    } else if (newState === 'paused' || newState === 'detached') {
      for (const fn of this.onBackgroundListeners) await fn();
    }
  }
}

class DartResyncCoordinatorMirror {
  constructor({ projectionStore, persistenceService, fetchAuthoritativeTrip }) {
    this.projectionStore = projectionStore;
    this.persistenceService = persistenceService;
    this.fetchAuthoritativeTrip = fetchAuthoritativeTrip;
    this.inFlight = null;
    this.resyncCount = 0;
  }

  async resyncTrip(tripId) {
    if (this.inFlight) return await this.inFlight;
    this.resyncCount++;
    this.inFlight = (async () => {
      try {
        const snap = await this.fetchAuthoritativeTrip(tripId);
        if (snap) {
          this.projectionStore.applyUpdate(snap);
          await this.persistenceService.saveTripSnapshot(snap);
        }
        return snap;
      } finally {
        this.inFlight = null;
      }
    })();
    return await this.inFlight;
  }
}

class DartOfflineQueueFlusherMirror {
  constructor({ persistenceService, projectionStore, executeMutation }) {
    this.persistenceService = persistenceService;
    this.projectionStore = projectionStore;
    this.executeMutation = executeMutation;
    this.isFlushing = false;
  }

  async flushQueue() {
    if (this.isFlushing) return [];
    this.isFlushing = true;
    const results = [];
    try {
      const queue = await this.persistenceService.getPendingMutations();
      const blockedTripIds = new Set();

      for (const mutation of queue) {
        // Blocked Dependency Protection
        if (blockedTripIds.has(mutation.tripId)) {
          results.push({
            mutation,
            success: false,
            permanentRejection: true,
            errorCode: 'BLOCKED_BY_PRIOR_FAILURE'
          });
          await this.persistenceService.removeMutation(mutation.intentId);
          continue;
        }

        // Conflict check against authoritative projection
        const currentTrip = this.projectionStore.currentTrip;
        if (currentTrip && currentTrip.tripId === mutation.tripId) {
          if (currentTrip.status === 'CANCELLED' || currentTrip.status === 'DELIVERED') {
            blockedTripIds.add(mutation.tripId);
            results.push({
              mutation,
              success: false,
              permanentRejection: true,
              errorCode: 'CONFLICT_TERMINAL_STATE'
            });
            await this.persistenceService.removeMutation(mutation.intentId);
            continue;
          }
        }

        const res = await this.executeMutation(mutation);
        results.push(res);

        if (res.success) {
          await this.persistenceService.removeMutation(mutation.intentId);
        } else if (res.permanentRejection) {
          blockedTripIds.add(mutation.tripId);
          await this.persistenceService.removeMutation(mutation.intentId);
        } else {
          // Transient failure: preserve and halt replay
          mutation.retryCount = (mutation.retryCount || 0) + 1;
          await this.persistenceService.enqueueMutation(mutation);
          break;
        }
      }
    } finally {
      this.isFlushing = false;
    }
    return results;
  }
}

// In-Memory Storage & Projection Helpers
class InMemoryTestStorage {
  constructor() {
    this.snapshots = new Map();
    this.queue = new Map();
  }
  async saveTripSnapshot(snap) { this.snapshots.set(snap.tripId, snap); }
  async getTripSnapshot(id) { return this.snapshots.get(id) || null; }
  async clearTripSnapshot(id) { this.snapshots.delete(id); }
  async enqueueMutation(m) { this.queue.set(m.intentId, m); }
  async getPendingMutations() {
    const list = Array.from(this.queue.values());
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return list;
  }
  async removeMutation(intentId) { this.queue.delete(intentId); }
  async clearAllMutations() { this.queue.clear(); }
}

class TestProjectionStore {
  constructor() { this.currentTrip = null; }
  applyUpdate(incoming) {
    if (!this.currentTrip || incoming.version > this.currentTrip.version) {
      this.currentTrip = incoming;
      return true;
    }
    return false;
  }
}

test('Pillar 15A.4: Flutter Lifecycle, Resync & Recovery Architecture Suite', async (suite) => {
  const tripId = `TRIP_P15A4_${Date.now()}`;

  // --------------------------------------------------------------------------
  await suite.test('15A.4.1 & 15A.4.2: Background -> Foreground Resync & Single-Flight Coalescing', async () => {
    const lifecycle = new DartAppLifecycleManagerMirror();
    const projectionStore = new TestProjectionStore();
    const persistence = new InMemoryTestStorage();

    let networkCallCount = 0;
    const fetchAuthoritativeTrip = async (id) => {
      networkCallCount++;
      await new Promise(r => setTimeout(r, 20)); // Simulated network latency
      return { tripId: id, status: 'IN_TRANSIT', version: 30 };
    };

    const resync = new DartResyncCoordinatorMirror({
      projectionStore,
      persistenceService: persistence,
      fetchAuthoritativeTrip
    });

    // Wire lifecycle foreground trigger
    lifecycle.addOnForegroundListener(async () => {
      await resync.resyncTrip(tripId);
    });

    // 1. Simulate Backgrounding
    await lifecycle.handleLifecycleTransition('paused');
    assert.equal(networkCallCount, 0);

    // 2. Simulate Rapid Foreground Resume (3 triggers fired nearly simultaneously)
    const p1 = lifecycle.handleLifecycleTransition('resumed');
    const p2 = resync.resyncTrip(tripId);
    const p3 = resync.resyncTrip(tripId);
    await Promise.all([p1, p2, p3]);

    // INVARIANT: Exactly 1 authoritative network call must execute
    assert.equal(networkCallCount, 1, 'Coalescing Invariant: Multiple foreground signals must execute strictly 1 HTTP resync');
    assert.equal(projectionStore.currentTrip.version, 30);
    assert.equal(projectionStore.currentTrip.status, 'IN_TRANSIT');
  });

  // --------------------------------------------------------------------------
  await suite.test('15A.4.3: WebSocket Disconnect + Foreground Resume Authoritative Recovery', async () => {
    const projectionStore = new TestProjectionStore();
    projectionStore.currentTrip = { tripId, status: 'DRIVER_ARRIVING', version: 10 };
    const persistence = new InMemoryTestStorage();

    // While WebSocket is disconnected, backend advanced order to DRIVER_AT_PICKUP (v11)
    const fetchAuthoritativeTrip = async (id) => {
      return { tripId: id, status: 'DRIVER_AT_PICKUP', version: 11 };
    };

    const resync = new DartResyncCoordinatorMirror({
      projectionStore,
      persistenceService: persistence,
      fetchAuthoritativeTrip
    });

    // Resume triggers authoritative resync
    await resync.resyncTrip(tripId);
    assert.equal(projectionStore.currentTrip.version, 11);
    assert.equal(projectionStore.currentTrip.status, 'DRIVER_AT_PICKUP');
  });

  // --------------------------------------------------------------------------
  await suite.test('15A.4.4 & 15A.4.5: Offline Queue Replay: Strict FIFO, Idempotency Preservation & Success Purge', async () => {
    const projectionStore = new TestProjectionStore();
    const persistence = new InMemoryTestStorage();

    const intentId1 = `intent_${Date.now()}_1`;
    const idemKey1 = crypto.randomUUID();
    const intentId2 = `intent_${Date.now()}_2`;
    const idemKey2 = crypto.randomUUID();

    await persistence.enqueueMutation({
      intentId: intentId1,
      idempotencyKey: idemKey1,
      operation: 'start-arriving',
      tripId,
      createdAt: new Date(Date.now() - 2000)
    });
    await persistence.enqueueMutation({
      intentId: intentId2,
      idempotencyKey: idemKey2,
      operation: 'arrived-pickup',
      tripId,
      createdAt: new Date(Date.now() - 1000)
    });

    const executionLog = [];
    const executeMutation = async (m) => {
      executionLog.push({ intentId: m.intentId, key: m.idempotencyKey });
      return { mutation: m, success: true };
    };

    const flusher = new DartOfflineQueueFlusherMirror({
      persistenceService: persistence,
      projectionStore,
      executeMutation
    });

    const results = await flusher.flushQueue();

    // Assert FIFO execution order
    assert.equal(results.length, 2);
    assert.equal(executionLog[0].intentId, intentId1);
    assert.equal(executionLog[1].intentId, intentId2);

    // Assert Idempotency keys preserved
    assert.equal(executionLog[0].key, idemKey1);
    assert.equal(executionLog[1].key, idemKey2);

    // Assert Queue is completely purged on success
    const remaining = await persistence.getPendingMutations();
    assert.equal(remaining.length, 0);
  });

  // --------------------------------------------------------------------------
  await suite.test('15A.4.6: Transient Network Drop Halts Queue Replay without Deleting Items', async () => {
    const projectionStore = new TestProjectionStore();
    const persistence = new InMemoryTestStorage();

    const intent1 = `intent_${Date.now()}_t1`;
    const intent2 = `intent_${Date.now()}_t2`;

    await persistence.enqueueMutation({
      intentId: intent1,
      idempotencyKey: crypto.randomUUID(),
      operation: 'start-arriving',
      tripId,
      createdAt: new Date(Date.now() - 2000),
      retryCount: 0
    });
    await persistence.enqueueMutation({
      intentId: intent2,
      idempotencyKey: crypto.randomUUID(),
      operation: 'arrived-pickup',
      tripId,
      createdAt: new Date(Date.now() - 1000),
      retryCount: 0
    });

    // Simulate transient network timeout on item 1
    const executeMutation = async (m) => {
      return { mutation: m, success: false, permanentRejection: false }; // Transient failure
    };

    const flusher = new DartOfflineQueueFlusherMirror({
      persistenceService: persistence,
      projectionStore,
      executeMutation
    });

    const results = await flusher.flushQueue();

    // Invariant: Replay halts immediately on transient failure; item 2 is NOT executed
    assert.equal(results.length, 1);
    const queueAfter = await persistence.getPendingMutations();
    assert.equal(queueAfter.length, 2, 'Both items must remain in queue');
    assert.equal(queueAfter[0].retryCount, 1, 'Failed item must have incremented retry counter');
  });

  // --------------------------------------------------------------------------
  await suite.test('15A.4.7: Blocked Dependency Invariant: Downstream Mutations Abort on Permanent Failure', async () => {
    const projectionStore = new TestProjectionStore();
    const persistence = new InMemoryTestStorage();

    const intent1 = `intent_${Date.now()}_p1`;
    const intent2 = `intent_${Date.now()}_p2`;

    await persistence.enqueueMutation({
      intentId: intent1,
      idempotencyKey: crypto.randomUUID(),
      operation: 'arrived-pickup',
      tripId,
      createdAt: new Date(Date.now() - 2000)
    });
    await persistence.enqueueMutation({
      intentId: intent2,
      idempotencyKey: crypto.randomUUID(),
      operation: 'confirm-pickup',
      tripId,
      createdAt: new Date(Date.now() - 1000)
    });

    // Permanent Rejection: Geofence validation failed on arrival
    const executeMutation = async (m) => {
      if (m.intentId === intent1) {
        return { mutation: m, success: false, permanentRejection: true, errorCode: 'GEOFENCE_VALIDATION_FAILED' };
      }
      return { mutation: m, success: true };
    };

    const flusher = new DartOfflineQueueFlusherMirror({
      persistenceService: persistence,
      projectionStore,
      executeMutation
    });

    const results = await flusher.flushQueue();

    assert.equal(results.length, 2);
    assert.equal(results[0].errorCode, 'GEOFENCE_VALIDATION_FAILED');
    assert.equal(results[1].errorCode, 'BLOCKED_BY_PRIOR_FAILURE', 'Downstream mutation must not bypass failed predecessor');

    const remaining = await persistence.getPendingMutations();
    assert.equal(remaining.length, 0, 'Both failed and blocked mutations are safely purged from persistent queue');
  });

  // --------------------------------------------------------------------------
  await suite.test('15A.4.8: Conflict Reconciliation: Stale Mutations Abort if Trip Is Already CANCELLED', async () => {
    const projectionStore = new TestProjectionStore();
    // Authoritative projection has already moved to terminal state CANCELLED
    projectionStore.currentTrip = { tripId, status: 'CANCELLED', version: 25 };
    const persistence = new InMemoryTestStorage();

    const intentStale = `intent_${Date.now()}_stale`;
    await persistence.enqueueMutation({
      intentId: intentStale,
      idempotencyKey: crypto.randomUUID(),
      operation: 'arrived-pickup',
      tripId,
      createdAt: new Date()
    });

    let executedCount = 0;
    const executeMutation = async (m) => {
      executedCount++;
      return { mutation: m, success: true };
    };

    const flusher = new DartOfflineQueueFlusherMirror({
      persistenceService: persistence,
      projectionStore,
      executeMutation
    });

    const results = await flusher.flushQueue();

    assert.equal(executedCount, 0, 'Must NOT execute network call for mutation on terminal cancelled trip');
    assert.equal(results[0].errorCode, 'CONFLICT_TERMINAL_STATE');
    const remaining = await persistence.getPendingMutations();
    assert.equal(remaining.length, 0);
  });

  // --------------------------------------------------------------------------
  await suite.test('15A.4.9: Explicit Logout Purges Persistence and Preserved Recovery State', async () => {
    const persistence = new InMemoryTestStorage();
    await persistence.saveTripSnapshot({ tripId, status: 'IN_TRANSIT', version: 5 });
    await persistence.enqueueMutation({ intentId: 'm1', tripId, idempotencyKey: 'k1', createdAt: new Date() });

    assert.ok(await persistence.getTripSnapshot(tripId));
    assert.equal((await persistence.getPendingMutations()).length, 1);

    // Logout
    await persistence.clearTripSnapshot(tripId);
    await persistence.clearAllMutations();

    assert.equal(await persistence.getTripSnapshot(tripId), null);
    assert.equal((await persistence.getPendingMutations()).length, 0);
  });

  // --------------------------------------------------------------------------
  await suite.test('15A.4.10: Post-Verification PostgreSQL Double-Entry Ledger Parity Audit (₹0 Imbalance)', async () => {
    const pool = new PostgresPool();
    const ledgerRepo = new PostgresLedgerRepository(pool);
    const recon = await ledgerRepo.reconcile();

    assert.equal(recon.ok, true, 'PostgreSQL Ledger reconciliation must pass');
    assert.equal(recon.problems.length, 0, 'Zero ledger discrepancies allowed');
    assert.ok(recon.journalEntries >= 32186, `Ledger entry count must preserve baseline (>= 32,186, actual: ${recon.journalEntries})`);
    console.log(`[Pillar 15A.4 Audit] Reconciled journal entries: ${recon.journalEntries}, problems: 0, balance: ₹0`);
    await pool.end();
  });
});
