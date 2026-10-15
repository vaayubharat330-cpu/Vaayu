'use strict';

const crypto = require('crypto');
const { PostgresPool } = require('../../db/postgresClient');
const { metricsService } = require('../metricsService');
const { logger } = require('../logger');

/**
 * Standard Discrepancy Types
 */
const DISCREPANCY_TYPES = Object.freeze({
  MISSING_INTERNAL_ESCROW: 'MISSING_INTERNAL_ESCROW',     // Provider captured, but internal webhook was missed/lost
  FALSE_INTERNAL_SETTLEMENT: 'FALSE_INTERNAL_SETTLEMENT', // VAAYU settled, but provider reports payment failed/unauthorized
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',                     // Provider amount != internal amount
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',                 // Non-INR currency reported by provider
  STATUS_CONFLICT: 'STATUS_CONFLICT',                     // Provider status vs VAAYU state conflict
  ORPHAN_PROVIDER_PAYMENT: 'ORPHAN_PROVIDER_PAYMENT'      // Provider payment has no internal mapping
});

/**
 * VAAYU AUTOMATED PROVIDER RECONCILIATION WORKER (Phase F.5)
 * 
 * Periodically audits external provider payments against internal payment records,
 * detects discrepancies (e.g. missed webhooks, false settlements, amount mismatches),
 * logs discrepancies in `payment_discrepancy_records`, and auto-heals recoverable states
 * (such as missing escrow holds for confirmed captured payments).
 */
class ProviderReconciliationWorker {
  constructor({
    poolOrConfig,
    providerAdapter,
    paymentIntegrationService,
    batchSize = 50,
    pollIntervalMs = 60000,
    autoHealMissingEscrow = true,
    loggerInstance = null
  } = {}) {
    if (poolOrConfig && typeof poolOrConfig.query === 'function') {
      this.pool = poolOrConfig;
    } else {
      this.pool = new PostgresPool(poolOrConfig || {});
    }

    this.provider = providerAdapter;
    this.integrationService = paymentIntegrationService;
    this.batchSize = batchSize;
    this.pollIntervalMs = pollIntervalMs;
    this.autoHealMissingEscrow = autoHealMissingEscrow;
    this.logger = loggerInstance || logger;

    this.isRunning = false;
    this.isReconciling = false;
    this.timer = null;

    this.stats = {
      runsCompleted: 0,
      totalChecked: 0,
      totalMatched: 0,
      totalDiscrepancies: 0,
      totalAutoResolved: 0,
      lastRunAt: null
    };
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNextRun(0);
    this.logger.info('recon_worker_started', 'Provider Reconciliation Worker started', {
      intervalMs: this.pollIntervalMs,
      batchSize: this.batchSize
    });
  }

  async stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const start = Date.now();
    while (this.isReconciling && Date.now() - start < 5000) {
      await new Promise(res => setTimeout(res, 50));
    }
    this.logger.info('recon_worker_stopped', 'Provider Reconciliation Worker stopped');
  }

  scheduleNextRun(delayMs = this.pollIntervalMs) {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      try {
        await this.runReconciliationCycle();
      } catch (err) {
        this.logger.error('recon_worker_cycle_error', `Reconciliation cycle failed: ${err.message}`, { error: err.stack });
      } finally {
        if (this.isRunning) {
          this.scheduleNextRun(this.pollIntervalMs);
        }
      }
    }, delayMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Run a full reconciliation audit pass for the provider
   */
  async runReconciliationCycle(options = {}) {
    const limit = options.limit || this.batchSize;
    if (this.isReconciling) return null;
    this.isReconciling = true;

    const batchRef = `RECON_${this.provider?.name || 'rzp'}_${Date.now()}`;
    const startTime = new Date().toISOString();
    this.stats.lastRunAt = startTime;

    // 1. Create Reconciliation Batch Record
    await this.pool.query(`
      INSERT INTO payment_reconciliation_batches (
        batch_ref, provider, started_at, status
      ) VALUES ($1, $2, NOW(), 'RUNNING');
    `, [batchRef, this.provider?.name || 'razorpay']);

    let totalChecked = 0;
    let matchedCount = 0;
    let discrepancyCount = 0;
    let autoResolvedCount = 0;
    let manualReviewCount = 0;

    try {
      // 2. Fetch candidates for reconciliation from payment_provider_mappings
      // We look at mappings that were initiated or captured
      let querySql = `
        SELECT m.mapping_id, m.provider, m.provider_order_id, m.provider_payment_id,
               m.payment_id, m.trip_id, m.order_id, m.customer_id,
               m.expected_amount_paise, m.currency, m.status as mapping_status,
               t.state as internal_state, t.amount_paise as internal_amount_paise,
               t.escrow_paise as internal_escrow_paise
        FROM payment_provider_mappings m
        LEFT JOIN payment_transactions t ON t.payment_id = m.payment_id
        WHERE m.provider = $1
      `;
      const queryParams = [this.provider?.name || 'razorpay'];
      if (options?.paymentId) {
        queryParams.push(options.paymentId);
        querySql += ` AND m.payment_id = $${queryParams.length} `;
      }
      queryParams.push(limit);
      querySql += `
        ORDER BY m.updated_at DESC
        LIMIT $${queryParams.length};
      `;

      const mappingsRes = await this.pool.query(querySql, queryParams);

      const records = mappingsRes.rows;
      totalChecked = records.length;

      for (const rec of records) {
        const itemResult = await this._reconcileSingleRecord(batchRef, rec);
        if (itemResult.isMatch) {
          matchedCount++;
        } else {
          discrepancyCount++;
          if (itemResult.isAutoResolved) {
            autoResolvedCount++;
          } else {
            manualReviewCount++;
          }
        }
      }

      const isBalanced = (discrepancyCount === 0 || discrepancyCount === autoResolvedCount);

      // 3. Mark Batch Completed
      await this.pool.query(`
        UPDATE payment_reconciliation_batches
        SET status = 'COMPLETED',
            completed_at = NOW(),
            total_records_checked = $1,
            matched_count = $2,
            discrepancy_count = $3,
            auto_resolved_count = $4,
            manual_review_count = $5,
            is_balanced = $6,
            summary = $7
        WHERE batch_ref = $8;
      `, [
        totalChecked,
        matchedCount,
        discrepancyCount,
        autoResolvedCount,
        manualReviewCount,
        isBalanced,
        JSON.stringify({
          provider: this.provider?.name || 'razorpay',
          totalChecked,
          matchedCount,
          discrepancyCount,
          autoResolvedCount,
          manualReviewCount
        }),
        batchRef
      ]);

      this.stats.runsCompleted++;
      this.stats.totalChecked += totalChecked;
      this.stats.totalMatched += matchedCount;
      this.stats.totalDiscrepancies += discrepancyCount;
      this.stats.totalAutoResolved += autoResolvedCount;

      metricsService.increment('recon_runs_completed_total');
      metricsService.increment('recon_discrepancies_detected_total', discrepancyCount);

      return {
        batchRef,
        status: 'COMPLETED',
        totalChecked,
        matchedCount,
        discrepancyCount,
        autoResolvedCount,
        manualReviewCount,
        isBalanced
      };

    } catch (err) {
      await this.pool.query(`
        UPDATE payment_reconciliation_batches
        SET status = 'FAILED',
            completed_at = NOW(),
            summary = $1
        WHERE batch_ref = $2;
      `, [JSON.stringify({ error: err.message }), batchRef]);

      throw err;
    } finally {
      this.isReconciling = false;
    }
  }

  /**
   * Internal comparison of a single mapping against remote provider API & ledger
   */
  async _reconcileSingleRecord(batchRef, rec) {
    const providerPaymentId = rec.provider_payment_id;
    let remotePayment = null;

    // 1. Fetch remote provider state if payment ID is known
    if (providerPaymentId && this.provider && typeof this.provider.fetchPayment === 'function') {
      try {
        remotePayment = await this.provider.fetchPayment(providerPaymentId);
      } catch (err) {
        this.logger.warn('recon_fetch_payment_error', `Could not fetch remote payment ${providerPaymentId}: ${err.message}`);
      }
    }

    // CASE 1: Currency mismatch
    if (remotePayment && remotePayment.currency && remotePayment.currency !== 'INR') {
      await this._recordDiscrepancy({
        batchRef,
        discrepancyType: DISCREPANCY_TYPES.CURRENCY_MISMATCH,
        rec,
        remotePayment,
        resolutionStatus: 'OPEN',
        resolutionAction: 'FLAGGED_MANUAL_REVIEW',
        resolutionNotes: `Expected INR, but provider reports ${remotePayment.currency}`
      });
      return { isMatch: false, isAutoResolved: false };
    }

    // CASE 2: Amount mismatch
    if (remotePayment && remotePayment.amountPaise !== undefined && Number(remotePayment.amountPaise) !== Number(rec.expected_amount_paise)) {
      await this._recordDiscrepancy({
        batchRef,
        discrepancyType: DISCREPANCY_TYPES.AMOUNT_MISMATCH,
        rec,
        remotePayment,
        resolutionStatus: 'OPEN',
        resolutionAction: 'FLAGGED_MANUAL_REVIEW',
        resolutionNotes: `Expected ${rec.expected_amount_paise} paise, but provider reports ${remotePayment.amountPaise} paise`
      });
      return { isMatch: false, isAutoResolved: false };
    }

    // CASE 3: False internal settlement (VAAYU settled/escrowed, but remote provider reports payment failed)
    if (rec.internal_state && rec.internal_state !== 'INITIATED' && remotePayment && !remotePayment.isCaptured) {
      await this._recordDiscrepancy({
        batchRef,
        discrepancyType: DISCREPANCY_TYPES.FALSE_INTERNAL_SETTLEMENT,
        rec,
        remotePayment,
        resolutionStatus: 'OPEN',
        resolutionAction: 'FLAGGED_MANUAL_REVIEW',
        resolutionNotes: `CRITICAL: VAAYU internal state is ${rec.internal_state}, but provider status is ${remotePayment.status}`
      });
      return { isMatch: false, isAutoResolved: false };
    }

    // CASE 4: Remote payment captured, but VAAYU has NO escrow hold (Missed Webhook Scenario!)
    if (remotePayment && remotePayment.isCaptured && (!rec.internal_state || rec.internal_state === 'INITIATED')) {
      let isAutoResolved = false;
      let resolutionAction = 'FLAGGED_MANUAL_REVIEW';
      let resolutionNotes = 'Remote payment is captured at provider, but internal escrow hold was missing.';

      if (this.autoHealMissingEscrow && this.integrationService) {
        try {
          // Auto-heal: credit customer wallet and lock escrow hold
          // Idempotency keys must be <= 64 characters to fit VARCHAR(64)
          const hashSuffix = crypto.createHash('sha256').update(`${batchRef}:${rec.payment_id}`).digest('hex').slice(0, 40);
          const healKey = `HEAL:${hashSuffix}`;
          const topUpKey = `TOPUP:${hashSuffix}`;

          if (this.integrationService.psm?.ledger) {
            await this.integrationService.psm.ledger.topUpCustomerWallet({
              customerId: rec.customer_id,
              amountPaise: Number(rec.expected_amount_paise),
              idempotencyKey: topUpKey,
              metadata: { source: 'RECON_AUTO_HEAL', batchRef }
            });
          }

          const healRes = await this.integrationService.reserveEscrow({
            tripId: rec.trip_id,
            orderId: rec.order_id,
            customerId: rec.customer_id,
            amountPaise: Number(rec.expected_amount_paise),
            idempotencyKey: healKey
          });

          if (healRes.success) {
            isAutoResolved = true;
            resolutionAction = 'AUTO_HEALED_ESCROW';
            resolutionNotes = 'Auto-healed: Customer wallet credited and escrow hold placed via reconciliation.';

            // Update mapping table
            await this.pool.query(`
              UPDATE payment_provider_mappings
              SET status = 'CAPTURED', updated_at = NOW()
              WHERE mapping_id = $1;
            `, [rec.mapping_id]);
          }
        } catch (healErr) {
          resolutionNotes += ` Auto-heal failed: ${healErr.message}`;
        }
      }

      await this._recordDiscrepancy({
        batchRef,
        discrepancyType: DISCREPANCY_TYPES.MISSING_INTERNAL_ESCROW,
        rec,
        remotePayment,
        resolutionStatus: isAutoResolved ? 'AUTO_RESOLVED' : 'OPEN',
        resolutionAction,
        resolutionNotes
      });

      return { isMatch: false, isAutoResolved };
    }

    // Records match cleanly
    return { isMatch: true, isAutoResolved: false };
  }

  async _recordDiscrepancy({
    batchRef,
    discrepancyType,
    rec,
    remotePayment,
    resolutionStatus = 'OPEN',
    resolutionAction = 'FLAGGED_MANUAL_REVIEW',
    resolutionNotes = null
  }) {
    await this.pool.query(`
      INSERT INTO payment_discrepancy_records (
        batch_ref, provider, discrepancy_type, provider_order_id, provider_payment_id,
        payment_id, trip_id, customer_id, provider_amount_paise, internal_amount_paise,
        provider_status, internal_status, resolution_status, resolution_action,
        resolution_notes, resolved_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW());
    `, [
      batchRef,
      this.provider?.name || 'razorpay',
      discrepancyType,
      rec.provider_order_id,
      remotePayment?.providerPaymentId || rec.provider_payment_id || null,
      rec.payment_id,
      rec.trip_id,
      rec.customer_id,
      remotePayment?.amountPaise || null,
      rec.expected_amount_paise,
      remotePayment?.status || 'UNKNOWN',
      rec.internal_state || rec.mapping_status || 'UNKNOWN',
      resolutionStatus,
      resolutionAction,
      resolutionNotes,
      resolutionStatus === 'AUTO_RESOLVED' ? new Date().toISOString() : null
    ]);
  }

  /**
   * Admin API: Query all open or resolved discrepancies
   */
  async getDiscrepancies({ status = null, limit = 50, offset = 0 } = {}) {
    let sql = `
      SELECT discrepancy_id, batch_ref, provider, discrepancy_type,
             provider_order_id, provider_payment_id, payment_id, trip_id, customer_id,
             provider_amount_paise, internal_amount_paise, provider_status, internal_status,
             resolution_status, resolution_action, resolution_notes, resolved_at, created_at
      FROM payment_discrepancy_records
    `;
    const params = [];
    if (status) {
      params.push(status);
      sql += ` WHERE resolution_status = $${params.length}`;
    }
    params.push(limit, offset);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length};`;

    const res = await this.pool.query(sql, params);
    return res.rows.map(r => ({
      discrepancyId: r.discrepancy_id,
      batchRef: r.batch_ref,
      provider: r.provider,
      discrepancyType: r.discrepancy_type,
      providerOrderId: r.provider_order_id,
      providerPaymentId: r.provider_payment_id,
      paymentId: r.payment_id,
      tripId: r.trip_id,
      customerId: r.customer_id,
      providerAmountPaise: r.provider_amount_paise ? Number(r.provider_amount_paise) : null,
      internalAmountPaise: Number(r.internal_amount_paise),
      providerStatus: r.provider_status,
      internalStatus: r.internal_status,
      resolutionStatus: r.resolution_status,
      resolutionAction: r.resolution_action,
      resolutionNotes: r.resolution_notes,
      resolvedAt: r.resolved_at,
      createdAt: r.created_at
    }));
  }

  /**
   * Admin API: Resolve a discrepancy manually
   */
  async resolveDiscrepancyManually(discrepancyId, { action = 'RESOLVED_MANUAL', notes = 'Admin audit resolution' } = {}) {
    const res = await this.pool.query(`
      UPDATE payment_discrepancy_records
      SET resolution_status = 'RESOLVED_MANUAL',
          resolution_action = $1,
          resolution_notes = $2,
          resolved_at = NOW(),
          updated_at = NOW()
      WHERE discrepancy_id = $3
      RETURNING *;
    `, [action, notes, discrepancyId]);

    return res.rows.length > 0 ? res.rows[0] : null;
  }
}

module.exports = {
  ProviderReconciliationWorker,
  DISCREPANCY_TYPES
};
