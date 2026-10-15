'use strict';

/**
 * Pillar 5b: Full Platform Multi-Tier Scale Certification Test Suite
 *
 * Verifies cross-subsystem correctness, latencies, and financial invariants
 * under concurrent multi-tier traffic:
 * 1. GPS Telemetry Stream (High-frequency updates, out-of-order protection)
 * 2. Multi-Driver Dispatch Races (Redis reservation locks, zero double assignment)
 * 3. End-to-End Order Lifecycles (Customer order -> Escrow -> Transit -> Delivery -> Settlement)
 * 4. Cross-Subsystem Degradation & State Invariance (Zero ledger imbalance)
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { FullPlatformScaleHarness } = require('../../src/services/ledger/fullPlatformScaleHarness');

test('VAAYU Operational Certification: Pillar 5b Full Platform Scale Suite', async (suite) => {
  const harness = new FullPlatformScaleHarness({ poolSize: 30 });
  await harness.init();

  suite.after(async () => {
    await harness.close();
  });

  // Scenario 1: GPS Telemetry Ingestion Concurrency
  await suite.test('1. GPS Telemetry Stream: High-Frequency Concurrency & Replay Protection', async () => {
    const res = await harness.runGpsTelemetryBenchmark({ numDrivers: 40, updatesPerDriver: 15, concurrency: 12 });
    console.log(`   [GPS Results] Total Pings: ${res.totalPings} | Rate: ${res.tps} pings/sec | p50: ${res.p50}ms | p95: ${res.p95}ms`);

    assert.ok(res.validUpdates > 0, 'Valid GPS pings should be processed');
    assert.equal(res.stalePingRejected, true, 'Stale/out-of-order GPS ping must be strictly rejected');
    assert.ok(res.tps >= 100, `GPS ingestion rate should be >= 100 pings/sec, got: ${res.tps}`);
  });

  // Scenario 2: Multi-Driver Dispatch Race for Shared Orders (Anti-Double-Assignment)
  await suite.test('2. Multi-Driver Dispatch Race: Redis Locking Prevents Double Assignment', async () => {
    const res = await harness.runDispatchRaceBenchmark({ numOrders: 25, competingDriversPerOrder: 4 });
    console.log(`   [Dispatch Race Results] Orders: ${res.numOrders} | Successful: ${res.successfulAssignments} | Double Assigned: ${res.doubleAssignments} | Collisions: ${res.expectedCollisions}`);

    assert.equal(res.doubleAssignments, 0, 'Zero double assignments permitted under concurrent races');
    assert.equal(res.successfulAssignments, res.numOrders, 'All contested orders must resolve to exactly 1 assigned driver');
    assert.ok(res.expectedCollisions > 0, 'Losing competitors must encounter lock collision rather than double assignment');
  });

  // Scenario 3: End-to-End Multi-Tier Trips Under Load
  await suite.test('3. End-to-End Multi-Tier Trips: Complete Order, Transit, Settlement & Outbox Lifecycle', async () => {
    const res = await harness.runFullLifecycleBenchmark({ numTrips: 40, concurrency: 8 });
    console.log(`   [Full Lifecycle Results] Trips: ${res.numTrips} | Completed: ${res.completedTrips} | Failed: ${res.failedTrips} | Rate: ${res.tps} trips/sec | p95: ${res.p95}ms`);
    console.log(`   [Audit] Ledger Imbalance: ₹${res.audit.ledgerImbalance} | Recon OK: ${res.audit.reconciliationOk} | Pending Outbox: ${res.audit.pendingOutbox}`);

    assert.equal(res.failedTrips, 0, `Zero trips should fail during end-to-end execution, got errors: ${JSON.stringify(res.errors)}`);
    assert.equal(res.completedTrips, res.numTrips, 'All trips must successfully complete full lifecycle');
    assert.equal(res.audit.ledgerImbalance, 0, 'Ledger imbalance must strictly equal ₹0 across multi-tier trips');
    assert.equal(res.audit.reconciliationOk, true, 'Authoritative reconciliation must be 100% OK');
    assert.equal(res.audit.pendingOutbox, 0, 'Outbox backlog must completely drain to 0');
  });

  // Scenario 4: Cross-Subsystem Chaos & Graceful Degradation
  await suite.test('4. Cross-Subsystem Degradation: Illegal State & Double-Settle Protection', async () => {
    const res = await harness.runGracefulDegradationBenchmark();
    console.log(`   [Degradation Results] Invalid GPS Blocked: ${res.invalidGpsHandledCleanly} | First Settle: ${res.firstSettleSuccess} | Second Settle Blocked: ${res.doubleSettleBlocked}`);

    assert.equal(res.invalidGpsHandledCleanly, true, 'Invalid GPS ping must be handled cleanly without crashing');
    assert.equal(res.firstSettleSuccess, true, 'First legitimate settlement must succeed');
    assert.equal(res.doubleSettleBlocked, true, 'Attempting double settlement on settled trip must be blocked');
    assert.equal(res.ledgerImbalance, 0, 'Ledger imbalance must remain strictly ₹0');
    assert.equal(res.reconciliationOk, true, 'Reconciliation must remain 100% OK');
  });
});
