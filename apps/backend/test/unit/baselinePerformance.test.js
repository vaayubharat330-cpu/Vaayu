'use strict';

/**
 * Pillar 5a: Baseline Performance & Load Testing Runner
 *
 * Runs the 5 benchmark categories against PostgreSQL, measures throughput & percentiles,
 * asserts strict pass criteria, and verifies post-load financial recovery.
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { BaselinePerformanceHarness } = require('../../src/services/ledger/baselinePerformanceHarness');

test('VAAYU Operational Certification: Pillar 5a Baseline Performance Suite', async (t) => {
  const harness = new BaselinePerformanceHarness({ poolSize: 25 });
  await harness.init();

  t.after(async () => {
    await harness.close();
  });

  // Benchmark 1: Ledger Transaction Throughput
  await t.test('1. Ledger Transaction Throughput: Sustainable TPS and Latency Envelope', async () => {
    const res = await harness.benchmarkLedgerThroughput({ totalOps: 200, concurrency: 12 });
    console.log(`   [B1 Results] TPS: ${res.stats.tps} | p50: ${res.stats.p50}ms | p95: ${res.stats.p95}ms | p99: ${res.stats.p99}ms | max: ${res.stats.max}ms`);

    // Pre-established Pass Criteria
    assert.ok(res.stats.tps >= 50, `Ledger TPS should be >= 50 TPS, achieved: ${res.stats.tps}`);
    assert.ok(res.stats.p95 <= 150, `Ledger p95 latency should be <= 150ms, achieved: ${res.stats.p95}ms`);
    assert.equal(res.errorCount, 0, `Zero errors expected on ledger transactions, got: ${res.errorCount}`);
  });

  // Benchmark 2: Concurrent Escrow, Settlement, and Refund Contention
  await t.test('2. Lifecycle Contention: Concurrent Escrow / Settle / Refund Serialization', async () => {
    const res = await harness.benchmarkLifecycleContention({ totalTrips: 100, concurrency: 10 });
    console.log(`   [B2 Results] Operations/sec: ${res.stats.tps} | p50: ${res.stats.p50}ms | p95: ${res.stats.p95}ms | p99: ${res.stats.p99}ms | max: ${res.stats.max}ms`);

    // Pre-established Pass Criteria
    assert.ok(res.stats.tps >= 20, `Lifecycle TPS should be >= 20 TPS, achieved: ${res.stats.tps}`);
    assert.ok(res.stats.p95 <= 350, `Lifecycle p95 latency should be <= 350ms, achieved: ${res.stats.p95}ms`);
    assert.equal(res.errorCount, 0, `Zero unhandled serialization/lock errors, got: ${res.errorCount}`);
  });

  // Benchmark 3: Webhook Ingestion Rate & Duplicate Suppression
  await t.test('3. Webhook Ingestion: Events/sec, Cryptographic Verification & Duplicate Replays', async () => {
    const res = await harness.benchmarkWebhookIngestion({ totalEvents: 150, duplicateRatio: 0.3, concurrency: 10 });
    console.log(`   [B3 Results] Ingestion Rate: ${res.stats.tps} events/sec | Replays: ${res.duplicateReplaysCount} | p95: ${res.stats.p95}ms`);

    // Pre-established Pass Criteria
    assert.ok(res.stats.tps >= 30, `Ingestion rate should be >= 30 events/sec, achieved: ${res.stats.tps}`);
    assert.ok(res.duplicateReplaysCount > 0, 'Duplicate events must be detected and safely absorbed');
    assert.equal(res.errorCount, 0, `Zero ingestion failures, got: ${res.errorCount}`);
  });

  // Benchmark 4: Outbox Dispatcher Drain & Batch Latency
  await t.test('4. Outbox Dispatcher: Events/sec Drain Rate & Batch Dispatch Latency', async () => {
    const res = await harness.benchmarkOutboxDrain({ seedEvents: 100, batchSize: 50 });
    console.log(`   [B4 Results] Drain Rate: ${res.drainEps} events/sec | Batch Latency p95: ${res.batchLatencyStats.p95}ms`);

    // Pre-established Pass Criteria
    assert.ok(res.drainEps >= 50, `Outbox drain rate should be >= 50 events/sec, achieved: ${res.drainEps}`);
    assert.equal(res.totalDispatched, 100, 'All seeded events must be completely dispatched');
  });

  // Benchmark 5: Mixed-Traffic Concurrency & Post-Load Financial Recovery Drain Test
  await t.test('5. Mixed-Traffic Saturation & Post-Load Recovery: Zero Imbalance & Backlog Drain', async () => {
    const res = await harness.benchmarkMixedTrafficAndRecovery({ durationSeconds: 4, concurrency: 12 });
    console.log(`   [B5 Results] Mixed Load Ops: ${res.completedOps} ops in ${res.durationSeconds}s (${res.loadStats.tps} TPS) | Failed: ${res.failedOps}`);
    console.log(`   [Recovery Audit] Pending Outbox: ${res.postLoadRecovery.outboxPendingBacklog} | Imbalance: ₹${res.postLoadRecovery.ledgerImbalance} | Recon OK: ${res.postLoadRecovery.reconciliationOk}`);

    // Pre-established Pass Criteria
    assert.equal(res.failedOps, 0, 'Zero unhandled errors during mixed load');
    assert.equal(res.postLoadRecovery.ledgerImbalance, 0, 'Ledger imbalance must strictly equal ₹0');
    assert.equal(res.postLoadRecovery.reconciliationOk, true, 'Authoritative reconciliation must be 100% OK');
    assert.equal(res.postLoadRecovery.orphanPostings, 0, 'Zero orphaned postings permitted');
    assert.equal(res.postLoadRecovery.unbalancedJournalEntries, 0, 'Zero unbalanced journal entries permitted');
    assert.equal(res.postLoadRecovery.outboxPendingBacklog, 0, 'Outstanding outbox backlog must completely drain to 0');
  });
});
