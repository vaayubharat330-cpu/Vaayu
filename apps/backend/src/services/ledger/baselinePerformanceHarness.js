'use strict';

/**
 * VAAYU Milestone Pillar 5a: Baseline Performance & Load Testing Suite
 *
 * Measures the existing FROZEN financial architecture (F.1 through F.7)
 * across five distinct benchmark categories:
 * 
 * 1. Ledger Transaction Throughput (topUpCustomerWallet, balanced journal entries)
 * 2. Concurrent Escrow / Settlement / Refund Lifecycle Contention
 * 3. Webhook Ingestion Rate & Duplicate Suppression Under Concurrency
 * 4. Outbox Dispatcher Drain Rate & Batch Processing Latency
 * 5. Mixed-Traffic Saturation & Post-Load Financial Recovery Drain Test
 *
 * Tracks:
 * - TPS (Transactions per second)
 * - Latency: p50, p95, p99, max latency
 * - Financial Correctness: Ledger imbalance (₹0), duplicate mutations (0), unhandled errors (0)
 * - Post-Load Recovery: Outbox backlog drain, zero orphaned locks, clean reconciliation
 */

require('dotenv').config();
const crypto = require('crypto');
const os = require('os');
const { PostgresPool } = require('../../db/postgresClient');
const { PostgresLedgerRepository } = require('./postgresLedgerRepository');
const { PaymentStateMachine } = require('./paymentStateMachine');
const { PaymentIntegrationService } = require('./paymentIntegrationService');
const { PaymentIngestionService } = require('./paymentIngestionService');
const { RazorpayProvider } = require('./providers/razorpayProvider');
const { OutboxDispatcher } = require('./outboxDispatcher');
const { runMigrations } = require('../../db/runLedgerMigrations');

// Helper to compute percentiles from sorted array of latencies
function computeStats(latenciesMs, durationSeconds) {
  if (!latenciesMs || latenciesMs.length === 0) {
    return { count: 0, tps: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, avg: 0 };
  }
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p50 = sorted[Math.floor(count * 0.50)];
  const p95 = sorted[Math.floor(count * 0.95)] || sorted[count - 1];
  const p99 = sorted[Math.floor(count * 0.99)] || sorted[count - 1];
  const max = sorted[count - 1];
  const min = sorted[0];
  const avg = Number((sum / count).toFixed(2));
  const tps = Number((count / durationSeconds).toFixed(1));
  return { count, tps, min, p50, p95, p99, max, avg };
}

class BaselinePerformanceHarness {
  constructor(options = {}) {
    this.connectionString = options.connectionString || process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
    this.poolSize = options.poolSize || 25;
    this.pool = new PostgresPool({ connectionString: this.connectionString, max: this.poolSize });
    this.repo = new PostgresLedgerRepository(this.pool);
    // Bind PaymentIntegrationService to the real persistent postgres ledger repository
    this.integrationService = new PaymentIntegrationService({ ledgerService: this.repo });
    
    this.razorpayProvider = new RazorpayProvider({
      keyId: 'rzp_test_bench',
      keySecret: 'secret_bench_998811'
    });
    this.ingestionService = new PaymentIngestionService({
      poolOrConfig: this.pool,
      paymentIntegrationService: this.integrationService,
      providers: new Map([['razorpay', this.razorpayProvider]]),
      webhookSecret: 'secret_bench_998811'
    });

    this.dispatcher = new OutboxDispatcher({ poolOrConfig: this.pool, batchSize: 50 });
  }

  async init() {
    await runMigrations();
  }

  async close() {
    await this.pool.end();
  }

  /**
   * Benchmark 1: Ledger Transaction Throughput
   * Direct atomic double-entry postings (topUpCustomerWallet)
   */
  async benchmarkLedgerThroughput({ totalOps = 500, concurrency = 15 } = {}) {
    console.log(`\n[Benchmark 1] Running Ledger Transaction Throughput (${totalOps} ops, concurrency: ${concurrency})...`);
    const latencies = [];
    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    const startTime = Date.now();
    let currentOp = 0;

    const worker = async () => {
      while (true) {
        const opIdx = currentOp++;
        if (opIdx >= totalOps) break;

        const customerId = `cust_perf1_${opIdx}`;
        const key = `IDEM_PERF1_${startTime}_${opIdx}`;
        const opStart = Date.now();
        try {
          const res = await this.repo.topUpCustomerWallet({
            customerId,
            amountPaise: 10000,
            idempotencyKey: key,
            metadata: { benchmark: 'P5a_B1', opIdx }
          });
          latencies.push(Date.now() - opStart);
          if (res.success) {
            successCount++;
          } else {
            errorCount++;
          }
        } catch (err) {
          latencies.push(Date.now() - opStart);
          errorCount++;
          errors.push(err.message);
        }
      }
    };

    const workers = [];
    for (let c = 0; c < concurrency; c++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    const durationSeconds = (Date.now() - startTime) / 1000;
    const stats = computeStats(latencies, durationSeconds);
    return {
      category: 'LEDGER_THROUGHPUT',
      totalOps,
      concurrency,
      successCount,
      errorCount,
      durationSeconds: Number(durationSeconds.toFixed(2)),
      stats,
      sampleErrors: errors.slice(0, 3)
    };
  }

  /**
   * Benchmark 2: Concurrent Escrow, Settlement, and Refund Contention
   */
  async benchmarkLifecycleContention({ totalTrips = 100, concurrency = 10 } = {}) {
    console.log(`\n[Benchmark 2] Running Lifecycle Contention (${totalTrips} complete trips: Escrow -> Settle/Refund)...`);
    const latencies = [];
    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    const startTime = Date.now();
    let currentIdx = 0;

    const worker = async () => {
      while (true) {
        const idx = currentIdx++;
        if (idx >= totalTrips) break;

        const tripId = `trip_perf2_${startTime}_${idx}`;
        const customerId = `cust_perf2_${idx}`;
        const driverId = `driver_perf2_${idx}`;
        const amountPaise = 25000; // ₹250.00
        const opStart = Date.now();

        try {
          // 1. Ensure customer has wallet balance
          await this.repo.topUpCustomerWallet({
            customerId,
            amountPaise: 50000,
            idempotencyKey: `IDEM_TOP_${tripId}`
          });

          // 2. Reserve Escrow Hold
          const escrowRes = await this.integrationService.reserveEscrow({
            tripId,
            orderId: `order_${tripId}`,
            customerId,
            amountPaise,
            idempotencyKey: `IDEM_ESC_${tripId}`
          });

          if (!escrowRes.success) throw new Error(JSON.stringify(escrowRes.error));

          // 3. Settle or Refund (80% settle, 20% refund)
          if (idx % 5 === 0) {
            const refRes = await this.integrationService.refundTrip({
              tripId,
              amountPaise,
              reason: 'Customer cancelled prior to pickup',
              idempotencyKey: `IDEM_REF_${tripId}`
            });
            if (!refRes.success) throw new Error(JSON.stringify(refRes.error));
          } else {
            const setRes = await this.integrationService.settleTrip({
              tripId,
              driverId,
              amountPaise,
              idempotencyKey: `IDEM_SET_${tripId}`
            });
            if (!setRes.success) throw new Error(JSON.stringify(setRes.error));
          }

          latencies.push(Date.now() - opStart);
          successCount++;
        } catch (err) {
          latencies.push(Date.now() - opStart);
          errorCount++;
          errors.push(err.message);
        }
      }
    };

    const workers = [];
    for (let c = 0; c < concurrency; c++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    const durationSeconds = (Date.now() - startTime) / 1000;
    const stats = computeStats(latencies, durationSeconds);
    return {
      category: 'LIFECYCLE_CONTENTION',
      totalTrips,
      concurrency,
      successCount,
      errorCount,
      durationSeconds: Number(durationSeconds.toFixed(2)),
      stats,
      sampleErrors: errors.slice(0, 3)
    };
  }

  /**
   * Benchmark 3: Webhook Ingestion Rate & Duplicate Handling
   */
  async benchmarkWebhookIngestion({ totalEvents = 150, duplicateRatio = 0.3, concurrency = 10 } = {}) {
    console.log(`\n[Benchmark 3] Running Webhook Ingestion (${totalEvents} events, ${duplicateRatio * 100}% duplicates)...`);
    const latencies = [];
    let processedCount = 0;
    let duplicateReplaysCount = 0;
    let errorCount = 0;
    const errors = [];

    // Pre-seed mappings for test events
    const distinctEventsCount = Math.floor(totalEvents * (1 - duplicateRatio));
    const eventsPool = [];

    const runId = Date.now();
    for (let i = 0; i < distinctEventsCount; i++) {
      const tripId = `trip_perf3_${runId}_${i}`;
      const paymentId = `pay_perf3_${runId}_${i}`;
      const providerOrderId = `order_rzp_perf3_${runId}_${i}`;
      const customerId = `cust_perf3_${runId}_${i}`;
      const amountPaise = 18000;

      // Seed mapping
      await this.ingestionService.registerPaymentMapping({
        provider: 'razorpay',
        providerOrderId,
        paymentId,
        tripId,
        customerId,
        expectedAmountPaise: amountPaise
      });

      // Also ensure customer has funds for reserveEscrow
      await this.repo.topUpCustomerWallet({
        customerId,
        amountPaise: 50000,
        idempotencyKey: `IDEM_TOP_P3_${runId}_${i}`
      });

      eventsPool.push({
        event: 'payment.captured',
        providerEventId: `evt_rzp_perf3_${runId}_${i}`,
        payload: {
          payment: {
            entity: {
              id: `pay_prov_perf3_${i}`,
              order_id: providerOrderId,
              amount: amountPaise,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      });
    }

    // Build event list containing duplicates
    const allEvents = [];
    for (let i = 0; i < totalEvents; i++) {
      const selected = eventsPool[i % eventsPool.length];
      allEvents.push(selected);
    }

    const startTime = Date.now();
    let currentIdx = 0;

    const worker = async () => {
      while (true) {
        const idx = currentIdx++;
        if (idx >= allEvents.length) break;

        const ev = allEvents[idx];
        const rawBody = JSON.stringify(ev);
        const signature = crypto.createHmac('sha256', 'secret_bench_998811').update(rawBody).digest('hex');
        const opStart = Date.now();

        try {
          const res = await this.ingestionService.ingestWebhook({
            providerName: 'razorpay',
            rawBody,
            signature
          });
          latencies.push(Date.now() - opStart);

          if (res.success) {
            processedCount++;
            if (res.psmResult?.idempotentReplay) {
              duplicateReplaysCount++;
            }
          } else {
            errorCount++;
            errors.push(res.message);
          }
        } catch (err) {
          latencies.push(Date.now() - opStart);
          errorCount++;
          errors.push(err.message);
        }
      }
    };

    const workers = [];
    for (let c = 0; c < concurrency; c++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    const durationSeconds = (Date.now() - startTime) / 1000;
    const stats = computeStats(latencies, durationSeconds);
    return {
      category: 'WEBHOOK_INGESTION',
      totalEvents,
      concurrency,
      processedCount,
      duplicateReplaysCount,
      errorCount,
      durationSeconds: Number(durationSeconds.toFixed(2)),
      stats,
      sampleErrors: errors.slice(0, 3)
    };
  }

  /**
   * Benchmark 4: Outbox Dispatcher Drain & Batch Latency
   */
  async benchmarkOutboxDrain({ seedEvents = 100, batchSize = 50 } = {}) {
    console.log(`\n[Benchmark 4] Running Outbox Drain (${seedEvents} pending events, batchSize: ${batchSize})...`);
    
    // Clean any prior pending events to measure isolated seed drain
    await this.pool.query(`DELETE FROM payment_outbox WHERE status = 'PENDING';`);

    const seedStart = Date.now();
    for (let i = 0; i < seedEvents; i++) {
      const eventId = `EVT_OUT_PERF4_${seedStart}_${i}`;
      await this.pool.query(`
        INSERT INTO payment_outbox (
          event_id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count, next_attempt_at, created_at
        ) VALUES ($1, 'PAYMENT', $2, 'PaymentEscrowed', $3, 'PENDING', 0, NOW(), NOW());
      `, [
        eventId,
        `pay_perf4_${i}`,
        JSON.stringify({ paymentId: `pay_perf4_${i}`, amountPaise: 15000 })
      ]);
    }

    const dispatcher = new OutboxDispatcher({
      poolOrConfig: this.pool,
      batchSize
    });

    const batchLatencies = [];
    let totalDispatched = 0;
    const drainStart = Date.now();

    while (true) {
      const bStart = Date.now();
      const dispatched = await dispatcher.pollAndDispatch();
      const bLatency = Date.now() - bStart;
      batchLatencies.push(bLatency);

      if (dispatched === 0) break;
      totalDispatched += dispatched;
    }

    const drainDurationSeconds = (Date.now() - drainStart) / 1000;
    const stats = computeStats(batchLatencies, drainDurationSeconds);
    return {
      category: 'OUTBOX_DRAIN',
      seedEvents,
      totalDispatched,
      batchesRun: batchLatencies.length,
      drainDurationSeconds: Number(drainDurationSeconds.toFixed(2)),
      drainEps: Number((totalDispatched / drainDurationSeconds).toFixed(1)),
      batchLatencyStats: stats
    };
  }

  /**
   * Benchmark 5: Mixed-Traffic Concurrency & Post-Load Recovery Drain Test
   */
  async benchmarkMixedTrafficAndRecovery({ durationSeconds = 4, concurrency = 12 } = {}) {
    console.log(`\n[Benchmark 5] Running Mixed-Traffic Saturation & Post-Load Recovery (${durationSeconds}s sustained load, concurrency: ${concurrency})...`);
    
    let isRunning = true;
    let completedOps = 0;
    let failedOps = 0;
    const latencies = [];
    const startTime = Date.now();

    // Start background outbox dispatcher loop
    const dispatcher = new OutboxDispatcher({
      poolOrConfig: this.pool,
      batchSize: 50,
      pollIntervalMs: 200
    });
    dispatcher.start();

    const bench5Start = Date.now();
    // Mixed load workers
    const worker = async (workerId) => {
      let opIdx = 0;
      while (isRunning) {
        opIdx++;
        const currentOpSeq = `${bench5Start}_${workerId}_${opIdx}`;
        const opType = (opIdx + workerId) % 3; // 0: Top-Up, 1: Escrow, 2: Settle
        const tripId = `trip_mix_${currentOpSeq}`;
        const customerId = `cust_mix_${currentOpSeq}`;
        const driverId = `driver_mix_${currentOpSeq}`;
        const amountPaise = 20000;
        const opStart = Date.now();

        try {
          if (opType === 0) {
            await this.repo.topUpCustomerWallet({
              customerId,
              amountPaise: 50000,
              idempotencyKey: `IDEM_TOP_M_${currentOpSeq}`
            });
          } else if (opType === 1) {
            await this.repo.topUpCustomerWallet({
              customerId,
              amountPaise: 50000,
              idempotencyKey: `IDEM_TOP2_M_${currentOpSeq}`
            });
            await this.integrationService.reserveEscrow({
              tripId,
              orderId: `order_${tripId}`,
              customerId,
              amountPaise,
              idempotencyKey: `IDEM_ESC_M_${currentOpSeq}`
            });
          } else {
            await this.repo.topUpCustomerWallet({
              customerId,
              amountPaise: 50000,
              idempotencyKey: `IDEM_TOP3_M_${currentOpSeq}`
            });
            const esc = await this.integrationService.reserveEscrow({
              tripId,
              orderId: `order_${tripId}`,
              customerId,
              amountPaise,
              idempotencyKey: `IDEM_ESC3_M_${currentOpSeq}`
            });
            if (esc.success) {
              await this.integrationService.settleTrip({
                tripId,
                driverId,
                amountPaise,
                idempotencyKey: `IDEM_SET_M_${currentOpSeq}`
              });
            }
          }
          latencies.push(Date.now() - opStart);
          completedOps++;
        } catch (err) {
          latencies.push(Date.now() - opStart);
          failedOps++;
        }
      }
    };

    const workers = [];
    for (let c = 0; c < concurrency; c++) {
      workers.push(worker(c));
    }

    // Run for requested duration
    await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000));
    isRunning = false;
    await Promise.all(workers);

    const actualDuration = (Date.now() - startTime) / 1000;
    const loadStats = computeStats(latencies, actualDuration);

    console.log(`[Benchmark 5] Load phase stopped. Commenced post-load drain and integrity verification...`);
    await dispatcher.stop();

    // Let the system drain all pending outbox events completely
    while (true) {
      const dispatched = await dispatcher.pollAndDispatch();
      if (dispatched === 0) break;
    }

    // Check Post-Load Recovery Invariants:
    // 1. Outbox backlog drained
    const outboxBacklogRes = await this.pool.query(`SELECT COUNT(*) as count FROM payment_outbox WHERE status = 'PENDING';`);
    const outboxPending = Number(outboxBacklogRes.rows[0].count);

    // 2. Dead letter / failed count
    const outboxFailedRes = await this.pool.query(`SELECT COUNT(*) as count FROM payment_outbox WHERE status = 'FAILED';`);
    const outboxFailed = Number(outboxFailedRes.rows[0].count);

    // 3. Double-entry ledger balance check
    const recon = await this.repo.reconcile();

    // 4. Zero orphaned postings
    const orphanPostingsRes = await this.pool.query(`
      SELECT COUNT(*) as count 
      FROM ledger_postings p 
      LEFT JOIN ledger_journal_entries j ON p.entry_id = j.entry_id 
      WHERE j.entry_id IS NULL;
    `);
    const orphanPostings = Number(orphanPostingsRes.rows[0].count);

    // 5. Zero unbalanced journal entries
    const unbalEntriesRes = await this.pool.query(`
      SELECT COUNT(*) as count FROM (
        SELECT e.entry_id
        FROM ledger_journal_entries e
        JOIN ledger_postings p ON e.entry_id = p.entry_id
        GROUP BY e.entry_id
        HAVING SUM(CASE WHEN p.side = 'DEBIT' THEN p.amount_paise ELSE 0 END) !=
               SUM(CASE WHEN p.side = 'CREDIT' THEN p.amount_paise ELSE 0 END)
      ) unbal;
    `);
    const unbalEntries = Number(unbalEntriesRes.rows[0].count);

    // 6. Active database connections
    const connsRes = await this.pool.query(`
      SELECT count(*) as count FROM pg_stat_activity WHERE datname = current_database();
    `);
    const activeConnections = Number(connsRes.rows[0].count);

    return {
      category: 'MIXED_TRAFFIC_AND_RECOVERY',
      durationSeconds: Number(actualDuration.toFixed(2)),
      concurrency,
      completedOps,
      failedOps,
      loadStats,
      postLoadRecovery: {
        outboxPendingBacklog: outboxPending,
        outboxFailed,
        ledgerImbalance: recon.imbalancePaise || 0,
        reconciliationOk: recon.ok,
        reconciliationProblemsCount: recon.problems?.length || 0,
        orphanPostings,
        unbalancedJournalEntries: unbalEntries,
        activeConnections
      }
    };
  }
}

module.exports = {
  BaselinePerformanceHarness,
  computeStats
};
