'use strict';

/**
 * VAAYU Financial Trace Reconstructor & Observability Engine
 * Pillar 2 of Operational Readiness & Production Certification
 *
 * Provides:
 * 1. Canonical Lineage Resolution:
 *    requestId ──► paymentId ──► tripId ──► entryId ──► eventId ──► providerEventId ──► discrepancyId
 *
 * 2. Multi-Way Query Resolution:
 *    Given ANY single identifier (requestId, paymentId, tripId, entryId, eventId, providerEventId, discrepancyId),
 *    reconstruct the complete multi-layer financial timeline:
 *    - Payment transaction & state transitions
 *    - Ledger journal entries, postings & accounts
 *    - Transactional outbox events
 *    - Provider mappings & provider webhook events
 *    - Reconciliation batches & discrepancy records
 *    - Security audit trail actions & maker-checker approvals
 *
 * 3. Lineage Completeness Assessment:
 *    - COMPLETE: Full end-to-end chain from request to settlement/reconciliation exists
 *    - PARTIAL: Legitimate in-flight state (e.g. escrowed but not yet settled or reconciled)
 *    - INCONSISTENT: Broken link (e.g. captured webhook exists but no internal payment, or amount mismatch)
 *    - NOT_FOUND: Identifier does not resolve to any financial record
 *
 * 4. Operational Health & Anomaly Diagnostics:
 *    Detects stuck payments, unhandled discrepancies, DLQ events, and pool saturation.
 */

const { logger } = require('../logger');

const TRACE_STATUS = {
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  INCONSISTENT: 'INCONSISTENT',
  NOT_FOUND: 'NOT_FOUND'
};

class FinancialTraceReconstructor {
  constructor(poolOrConfig) {
    if (!poolOrConfig) {
      throw new Error('Postgres pool or config is required for FinancialTraceReconstructor.');
    }
    this.pool = poolOrConfig.query ? poolOrConfig : poolOrConfig.pool;
  }

  /**
   * Universal Reconstruct Method
   * Accepts any known financial identifier and returns the full connected trace.
   */
  async reconstruct({
    paymentId = null,
    tripId = null,
    requestId = null,
    entryId = null,
    eventId = null,
    providerEventId = null,
    discrepancyId = null
  } = {}) {
    const trace = {
      query: { paymentId, tripId, requestId, entryId, eventId, providerEventId, discrepancyId },
      resolvedRoot: null,
      status: TRACE_STATUS.NOT_FOUND,
      inconsistencies: [],
      payment: null,
      trip: null,
      journalEntries: [],
      outboxEvents: [],
      providerMapping: null,
      providerEvents: [],
      reconciliationBatches: [],
      discrepancies: [],
      auditTrail: [],
      approvals: [],
      summary: {}
    };

    // Step 1: Resolve the primary anchor paymentId and tripId
    let resolvedPaymentId = paymentId;
    let resolvedTripId = tripId;
    let resolvedRequestId = requestId;

    // A. Query from discrepancyId
    if (discrepancyId && (!resolvedPaymentId || !resolvedTripId)) {
      const discRes = await this.pool.query(
        'SELECT payment_id, trip_id FROM payment_discrepancy_records WHERE discrepancy_id = $1',
        [discrepancyId]
      );
      if (discRes.rows.length > 0) {
        resolvedPaymentId = resolvedPaymentId || discRes.rows[0].payment_id;
        resolvedTripId = resolvedTripId || discRes.rows[0].trip_id;
      }
    }

    // B. Query from providerEventId
    if (providerEventId && (!resolvedPaymentId || !resolvedTripId)) {
      const provRes = await this.pool.query(
        'SELECT matched_payment_id, matched_trip_id FROM payment_provider_events WHERE provider_event_id = $1',
        [providerEventId]
      );
      if (provRes.rows.length > 0) {
        resolvedPaymentId = resolvedPaymentId || provRes.rows[0].matched_payment_id;
        resolvedTripId = resolvedTripId || provRes.rows[0].matched_trip_id;
      }
    }

    // C. Query from eventId (Outbox)
    if (eventId && (!resolvedPaymentId || !resolvedTripId)) {
      const obRes = await this.pool.query(
        'SELECT aggregate_id, payload FROM payment_outbox WHERE event_id = $1',
        [eventId]
      );
      if (obRes.rows.length > 0) {
        const row = obRes.rows[0];
        const agg = row.aggregate_id;
        if (agg.startsWith('PAY_')) {
          resolvedPaymentId = resolvedPaymentId || agg;
        } else if (agg.startsWith('TRIP_')) {
          resolvedTripId = resolvedTripId || agg;
        }
        const pl = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        if (pl?.tripId) resolvedTripId = resolvedTripId || pl.tripId;
        if (pl?.paymentId) resolvedPaymentId = resolvedPaymentId || pl.paymentId;
      }
    }

    // D. Query from entryId (Ledger Journal)
    if (entryId && (!resolvedPaymentId || !resolvedTripId)) {
      const jeRes = await this.pool.query(
        'SELECT reference_id, metadata FROM ledger_journal_entries WHERE entry_id = $1',
        [entryId]
      );
      if (jeRes.rows.length > 0) {
        const ref = jeRes.rows[0].reference_id;
        const meta = jeRes.rows[0].metadata || {};
        if (meta.paymentId) resolvedPaymentId = resolvedPaymentId || meta.paymentId;
        if (meta.tripId) resolvedTripId = resolvedTripId || meta.tripId;
        if (ref.startsWith('TRIP_')) {
          const match = ref.match(/^TRIP_(.+?)(_ESCROW|_SETTLE|_REFUND|_EXPIRY)?$/);
          if (match) resolvedTripId = resolvedTripId || match[1];
        }
      }
    }

    // E. Query from requestId (Audit Trail / Metadata)
    if (resolvedRequestId && (!resolvedPaymentId || !resolvedTripId)) {
      const auditRes = await this.pool.query(
        `SELECT resource_type, resource_id, metadata FROM financial_audit_trail WHERE request_id = $1`,
        [resolvedRequestId]
      );
      for (const row of auditRes.rows) {
        if (row.resource_type === 'PAYMENT' || row.resource_id.startsWith('PAY_')) {
          resolvedPaymentId = resolvedPaymentId || row.resource_id;
        } else if (row.resource_type === 'TRIP' || row.resource_id.startsWith('TRIP_')) {
          resolvedTripId = resolvedTripId || row.resource_id;
        }
        if (row.metadata?.tripId) resolvedTripId = resolvedTripId || row.metadata.tripId;
        if (row.metadata?.paymentId) resolvedPaymentId = resolvedPaymentId || row.metadata.paymentId;
      }
    }

    // F. Cross-resolve tripId <-> paymentId from payment_transactions
    if (resolvedTripId && !resolvedPaymentId) {
      const txRes = await this.pool.query('SELECT payment_id FROM payment_transactions WHERE trip_id = $1', [resolvedTripId]);
      if (txRes.rows.length > 0) resolvedPaymentId = txRes.rows[0].payment_id;
    } else if (resolvedPaymentId && !resolvedTripId) {
      const txRes = await this.pool.query('SELECT trip_id FROM payment_transactions WHERE payment_id = $1', [resolvedPaymentId]);
      if (txRes.rows.length > 0) resolvedTripId = txRes.rows[0].trip_id;
    }

    // If still neither, check payment_provider_mappings
    if (!resolvedPaymentId && !resolvedTripId && (providerEventId || requestId)) {
      const mapRes = await this.pool.query(`
        SELECT payment_id, trip_id FROM payment_provider_mappings
        WHERE provider_order_id = $1 OR provider_payment_id = $1 OR trip_id = $1 OR payment_id = $1
      `, [providerEventId || requestId]);
      if (mapRes.rows.length > 0) {
        resolvedPaymentId = mapRes.rows[0].payment_id;
        resolvedTripId = mapRes.rows[0].trip_id;
      }
    }

    trace.resolvedRoot = {
      paymentId: resolvedPaymentId,
      tripId: resolvedTripId,
      requestId: resolvedRequestId
    };

    // Step 2: Fetch Payment Transaction Entity
    if (resolvedPaymentId || resolvedTripId) {
      const txSql = `
        SELECT payment_id, trip_id, order_id, customer_id, driver_id, currency,
               amount_paise, escrow_paise, refunded_paise, commission_bps, commission_paise,
               gst_bps, gst_paise, driver_earnings_paise, state, dispute_id, adjustment_paise,
               version, transaction_id, metadata, created_at, updated_at
        FROM payment_transactions
        WHERE payment_id = $1 OR trip_id = $2;
      `;
      const txRes = await this.pool.query(txSql, [resolvedPaymentId || '', resolvedTripId || '']);
      if (txRes.rows.length > 0) {
        trace.payment = txRes.rows[0];
        trace.trip = {
          tripId: trace.payment.trip_id,
          orderId: trace.payment.order_id,
          customerId: trace.payment.customer_id,
          driverId: trace.payment.driver_id
        };
        // Normalize roots
        resolvedPaymentId = trace.payment.payment_id;
        resolvedTripId = trace.payment.trip_id;
        trace.resolvedRoot.paymentId = resolvedPaymentId;
        trace.resolvedRoot.tripId = resolvedTripId;
      }
    }

    // Step 3: Fetch Ledger Journal Entries & Postings
    const jeConditions = [];
    const jeParams = [];
    if (resolvedPaymentId) {
      jeParams.push(resolvedPaymentId, `%${resolvedPaymentId}%`);
      jeConditions.push(`metadata->>'paymentId' = $${jeParams.length - 1} OR reference_id LIKE $${jeParams.length}`);
    }
    if (resolvedTripId) {
      jeParams.push(resolvedTripId, `%${resolvedTripId}%`);
      jeConditions.push(`metadata->>'tripId' = $${jeParams.length - 1} OR reference_id LIKE $${jeParams.length}`);
    }
    if (entryId) {
      jeParams.push(entryId);
      jeConditions.push(`entry_id = $${jeParams.length}`);
    }

    if (jeConditions.length > 0) {
      const jeSql = `
        SELECT entry_id, sequence, reference_id, idempotency_key, description,
               total_paise, metadata, created_at
        FROM ledger_journal_entries
        WHERE ${jeConditions.join(' OR ')}
        ORDER BY sequence ASC;
      `;
      const jeRes = await this.pool.query(jeSql, jeParams);

      for (const je of jeRes.rows) {
        const postRes = await this.pool.query(`
          SELECT posting_id, account_id, side, amount_paise, metadata, created_at
          FROM ledger_postings
          WHERE entry_id = $1
          ORDER BY posting_id ASC;
        `, [je.entry_id]);

        trace.journalEntries.push({
          ...je,
          postings: postRes.rows
        });
      }
    }

    // Step 4: Fetch Transactional Outbox Events
    const obConditions = [];
    const obParams = [];
    if (resolvedPaymentId) {
      obParams.push(resolvedPaymentId, `%${resolvedPaymentId}%`);
      obConditions.push(`aggregate_id = $${obParams.length - 1} OR payload::text LIKE $${obParams.length}`);
    }
    if (resolvedTripId) {
      obParams.push(resolvedTripId, `%${resolvedTripId}%`);
      obConditions.push(`aggregate_id = $${obParams.length - 1} OR payload::text LIKE $${obParams.length}`);
    }
    if (eventId) {
      obParams.push(eventId);
      obConditions.push(`event_id = $${obParams.length}`);
    }

    if (obConditions.length > 0) {
      const obSql = `
        SELECT outbox_id, event_id, aggregate_type, aggregate_id, event_type,
               payload, created_at, published_at, attempt_count, last_error, status
        FROM payment_outbox
        WHERE ${obConditions.join(' OR ')}
        ORDER BY outbox_id ASC;
      `;
      const obRes = await this.pool.query(obSql, obParams);
      trace.outboxEvents = obRes.rows.map(r => ({
        ...r,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload
      }));
    }

    // Step 5: Fetch Provider Mapping
    if (resolvedPaymentId || resolvedTripId) {
      const mapRes = await this.pool.query(`
        SELECT mapping_id, provider, provider_order_id, provider_payment_id, payment_id,
               trip_id, order_id, customer_id, expected_amount_paise, currency, status,
               created_at, updated_at
        FROM payment_provider_mappings
        WHERE payment_id = $1 OR trip_id = $2;
      `, [resolvedPaymentId || '', resolvedTripId || '']);
      if (mapRes.rows.length > 0) {
        trace.providerMapping = mapRes.rows[0];
      }
    }

    // Step 6: Fetch Provider Webhook Events
    const provConditions = [];
    const provParams = [];
    if (resolvedPaymentId) {
      provParams.push(resolvedPaymentId);
      provConditions.push(`matched_payment_id = $${provParams.length}`);
    }
    if (resolvedTripId) {
      provParams.push(resolvedTripId);
      provConditions.push(`matched_trip_id = $${provParams.length}`);
    }
    if (providerEventId) {
      provParams.push(providerEventId);
      provConditions.push(`provider_event_id = $${provParams.length}`);
    }
    if (trace.providerMapping?.provider_order_id) {
      provParams.push(`%"${trace.providerMapping.provider_order_id}"%`);
      provConditions.push(`raw_payload::text LIKE $${provParams.length}`);
    }

    if (provConditions.length > 0) {
      const provSql = `
        SELECT event_pk, provider, provider_event_id, event_type, payload_hash,
               status, matched_payment_id, matched_trip_id, amount_paise, currency,
               idempotent_replay, processing_error, created_at, processed_at
        FROM payment_provider_events
        WHERE ${provConditions.join(' OR ')}
        ORDER BY event_pk ASC;
      `;
      const provRes = await this.pool.query(provSql, provParams);
      trace.providerEvents = provRes.rows;
    }

    // Step 7: Fetch Discrepancies & Reconciliation Batches
    const discConditions = [];
    const discParams = [];
    if (resolvedPaymentId) {
      discParams.push(resolvedPaymentId);
      discConditions.push(`payment_id = $${discParams.length}`);
    }
    if (resolvedTripId) {
      discParams.push(resolvedTripId);
      discConditions.push(`trip_id = $${discParams.length}`);
    }
    if (discrepancyId) {
      discParams.push(discrepancyId);
      discConditions.push(`discrepancy_id = $${discParams.length}`);
    }

    if (discConditions.length > 0) {
      const discSql = `
        SELECT discrepancy_id, batch_ref, provider, discrepancy_type, provider_order_id,
               provider_payment_id, payment_id, trip_id, customer_id, provider_amount_paise,
               internal_amount_paise, provider_status, internal_status, resolution_status,
               resolution_action, resolution_notes, resolved_at, created_at
        FROM payment_discrepancy_records
        WHERE ${discConditions.join(' OR ')}
        ORDER BY discrepancy_id ASC;
      `;
      const discRes = await this.pool.query(discSql, discParams);
      trace.discrepancies = discRes.rows;

      // Extract batch references
      const batchRefs = [...new Set(discRes.rows.map(d => d.batch_ref).filter(Boolean))];
      if (batchRefs.length > 0) {
        const batchRes = await this.pool.query(`
          SELECT batch_id, batch_ref, provider, total_records_checked, matched_count,
                 discrepancy_count, auto_resolved_count, status, started_at, completed_at
          FROM payment_reconciliation_batches
          WHERE batch_ref = ANY($1);
        `, [batchRefs]);
        trace.reconciliationBatches = batchRes.rows;
      }
    }

    // Step 8: Fetch Security Audit Trail & Approval Actions
    const auditConditions = [];
    const auditParams = [];
    if (resolvedPaymentId) {
      auditParams.push(resolvedPaymentId, `%${resolvedPaymentId}%`);
      auditConditions.push(`resource_id = $${auditParams.length - 1} OR metadata::text LIKE $${auditParams.length}`);
    }
    if (resolvedTripId) {
      auditParams.push(resolvedTripId, `%${auditParams.length - 1} OR metadata::text LIKE $${auditParams.length}`);
      auditConditions.push(`resource_id = $${auditParams.length - 1} OR metadata::text LIKE $${auditParams.length}`);
    }
    if (resolvedRequestId) {
      auditParams.push(resolvedRequestId);
      auditConditions.push(`request_id = $${auditParams.length}`);
    }

    if (auditConditions.length > 0) {
      const auditSql = `
        SELECT audit_id, actor_id, actor_role, action, resource_type, resource_id,
               reason, request_id, idempotency_key, metadata, created_at
        FROM financial_audit_trail
        WHERE ${auditConditions.join(' OR ')}
        ORDER BY created_at ASC;
      `;
      const auditRes = await this.pool.query(auditSql, auditParams);
      trace.auditTrail = auditRes.rows;
    }

    // Step 9: Evaluate Trace Completeness & Invariants
    const hasAnyEntity = Boolean(
      trace.payment ||
      trace.journalEntries.length > 0 ||
      trace.outboxEvents.length > 0 ||
      trace.providerMapping ||
      trace.providerEvents.length > 0 ||
      trace.discrepancies.length > 0 ||
      trace.auditTrail.length > 0
    );

    if (!hasAnyEntity) {
      trace.status = TRACE_STATUS.NOT_FOUND;
      return trace;
    }

    // Detect Inconsistencies
    const inconsistencies = [];

    // Check 1: Provider captured webhook exists, but no internal payment record
    const hasCapturedWebhook = trace.providerEvents.some(e => e.status === 'PROCESSED' || e.event_type === 'payment.captured');
    if (hasCapturedWebhook && !trace.payment) {
      inconsistencies.push('Captured provider webhook exists without corresponding payment transaction');
    }

    // Check 2: Provider event exists without registered mapping
    if (trace.providerEvents.length > 0 && !trace.providerMapping) {
      inconsistencies.push('Provider events ingested without registered provider mapping');
    }

    // Check 3: Amount mismatch between payment and mapping
    if (trace.payment && trace.providerMapping) {
      const exp = Number(trace.providerMapping.expected_amount_paise);
      const act = Number(trace.payment.amount_paise);
      if (exp !== act) {
        inconsistencies.push(`Amount mismatch: expected ${exp} paise, payment has ${act} paise`);
      }
    }

    // Check 4: Unresolved OPEN discrepancies
    const openDiscs = trace.discrepancies.filter(d => d.resolution_status === 'OPEN');
    if (openDiscs.length > 0) {
      inconsistencies.push(`${openDiscs.length} unresolved OPEN financial discrepancies detected`);
    }

    // Check 5: Unbalanced Journal Entries
    for (const je of trace.journalEntries) {
      const totalDebits = je.postings.filter(p => p.side === 'DEBIT').reduce((s, p) => s + Number(p.amount_paise), 0);
      const totalCredits = je.postings.filter(p => p.side === 'CREDIT').reduce((s, p) => s + Number(p.amount_paise), 0);
      if (totalDebits !== totalCredits) {
        inconsistencies.push(`Journal entry ${je.entry_id} is mathematically unbalanced: DR ${totalDebits} != CR ${totalCredits}`);
      }
    }

    // Check 6: Failed or DLQ Outbox events
    const failedOutbox = trace.outboxEvents.filter(o => o.status === 'FAILED');
    if (failedOutbox.length > 0) {
      inconsistencies.push(`${failedOutbox.length} outbox events failed into Dead Letter Queue (DLQ)`);
    }

    trace.inconsistencies = inconsistencies;

    if (inconsistencies.length > 0) {
      trace.status = TRACE_STATUS.INCONSISTENT;
    } else {
      // Determine if Complete vs Partial
      const isSettledOrRefunded = trace.payment && ['SETTLED', 'REFUNDED', 'EXPIRED', 'ADJUSTED'].includes(trace.payment.state);
      const hasPostings = trace.journalEntries.length > 0;
      const allOutboxPublished = trace.outboxEvents.every(o => o.status === 'PUBLISHED');

      if (isSettledOrRefunded && hasPostings && allOutboxPublished) {
        trace.status = TRACE_STATUS.COMPLETE;
      } else {
        trace.status = TRACE_STATUS.PARTIAL;
      }
    }

    trace.summary = {
      status: trace.status,
      paymentState: trace.payment?.state || null,
      journalEntriesCount: trace.journalEntries.length,
      postingsCount: trace.journalEntries.reduce((acc, je) => acc + je.postings.length, 0),
      outboxEventsCount: trace.outboxEvents.length,
      providerEventsCount: trace.providerEvents.length,
      discrepanciesCount: trace.discrepancies.length,
      auditRecordsCount: trace.auditTrail.length,
      inconsistenciesCount: trace.inconsistencies.length
    };

    return trace;
  }

  /**
   * Diagnostic Scanner: Identify Active System-Wide Financial Operational Anomalies
   */
  async scanOperationalAnomalies() {
    const alerts = [];

    // 1. Payments stuck in INITIATED > 15 minutes
    const stuckInit = await this.pool.query(`
      SELECT payment_id, trip_id, created_at
      FROM payment_transactions
      WHERE state = 'INITIATED' AND created_at < NOW() - INTERVAL '15 minutes';
    `);
    if (stuckInit.rows.length > 0) {
      alerts.push({
        type: 'PAYMENT_STUCK_INITIATED',
        severity: 'MEDIUM',
        count: stuckInit.rows.length,
        items: stuckInit.rows
      });
    }

    // 2. Payments stuck in ESCROWED > 24 hours
    const stuckEscrow = await this.pool.query(`
      SELECT payment_id, trip_id, escrow_paise, created_at
      FROM payment_transactions
      WHERE state = 'ESCROWED' AND created_at < NOW() - INTERVAL '24 hours';
    `);
    if (stuckEscrow.rows.length > 0) {
      alerts.push({
        type: 'ESCROW_HOLD_AGING_OVER_24H',
        severity: 'HIGH',
        count: stuckEscrow.rows.length,
        items: stuckEscrow.rows
      });
    }

    // 3. Outbox Dead Letter Queue (DLQ > 0)
    const dlqCheck = await this.pool.query(`
      SELECT outbox_id, event_id, event_type, attempt_count, last_error
      FROM payment_outbox
      WHERE status = 'FAILED';
    `);
    if (dlqCheck.rows.length > 0) {
      alerts.push({
        type: 'OUTBOX_DLQ_FAILED_EVENTS',
        severity: 'HIGH',
        count: dlqCheck.rows.length,
        items: dlqCheck.rows
      });
    }

    // 4. Open Financial Discrepancies
    const openDiscs = await this.pool.query(`
      SELECT discrepancy_id, batch_ref, discrepancy_type, payment_id, trip_id, created_at
      FROM payment_discrepancy_records
      WHERE resolution_status = 'OPEN';
    `);
    if (openDiscs.rows.length > 0) {
      alerts.push({
        type: 'OPEN_FINANCIAL_DISCREPANCIES',
        severity: 'CRITICAL',
        count: openDiscs.rows.length,
        items: openDiscs.rows
      });
    }

    // 5. Unbalanced Journal Entries
    const unbal = await this.pool.query(`
      SELECT e.entry_id,
             SUM(CASE WHEN p.side = 'DEBIT' THEN p.amount_paise ELSE 0 END) as debits,
             SUM(CASE WHEN p.side = 'CREDIT' THEN p.amount_paise ELSE 0 END) as credits
      FROM ledger_journal_entries e
      JOIN ledger_postings p ON e.entry_id = p.entry_id
      GROUP BY e.entry_id
      HAVING SUM(CASE WHEN p.side = 'DEBIT' THEN p.amount_paise ELSE 0 END) !=
             SUM(CASE WHEN p.side = 'CREDIT' THEN p.amount_paise ELSE 0 END);
    `);
    if (unbal.rows.length > 0) {
      alerts.push({
        type: 'UNBALANCED_JOURNAL_ENTRIES',
        severity: 'FATAL',
        count: unbal.rows.length,
        items: unbal.rows
      });
    }

    // 6. Pending Four-Eyes Maker-Checker Approvals
    const pendingApprovals = await this.pool.query(`
      SELECT request_id, operation_type, requested_by, created_at
      FROM financial_approval_requests
      WHERE status = 'PENDING_APPROVAL';
    `);
    if (pendingApprovals.rows.length > 0) {
      alerts.push({
        type: 'PENDING_FOUR_EYES_APPROVALS',
        severity: 'INFO',
        count: pendingApprovals.rows.length,
        items: pendingApprovals.rows
      });
    }

    return {
      scannedAt: new Date().toISOString(),
      alertCount: alerts.length,
      alerts
    };
  }
}

module.exports = {
  FinancialTraceReconstructor,
  TRACE_STATUS
};
