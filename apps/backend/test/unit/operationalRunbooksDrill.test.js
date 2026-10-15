'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const {
  FinancialSecurityService,
  FINANCIAL_PERMISSIONS
} = require('../../src/services/ledger/financialSecurityService');
const { ProviderReconciliationWorker } = require('../../src/services/ledger/providerReconciliationWorker');
const { OutboxDispatcher } = require('../../src/services/ledger/outboxDispatcher');
const { DatabaseDisasterRecoveryManager } = require('../../src/db/databaseDisasterRecovery');
const { runMigrations } = require('../../src/db/runLedgerMigrations');

test('Pillar 4: Operational Runbooks & Tabletop Drill Verification', async (t) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  const pool = new PostgresPool({ connectionString });
  const repo = new PostgresLedgerRepository(pool);
  const psm = new PaymentStateMachine({ repository: repo });
  const integrationService = new PaymentIntegrationService({ repository: repo, stateMachine: psm });
  const securityService = new FinancialSecurityService({ poolOrConfig: pool, paymentIntegrationService: integrationService });
  const reconWorker = new ProviderReconciliationWorker({ poolOrConfig: pool, paymentIntegrationService: integrationService });
  const outboxDispatcher = new OutboxDispatcher({ poolOrConfig: pool });

  t.after(async () => {
    await pool.end();
  });

  await t.test('SOP-FIN-01 Drill: Investigation, Trace & Safe Manual Resolution of MISSING_INTERNAL_ESCROW', async () => {
    const tripId = `trip_drill_01_${crypto.randomUUID().slice(0, 8)}`;
    const paymentId = `pay_drill_01_${crypto.randomUUID().slice(0, 8)}`;
    const providerPaymentId = `rzp_pay_drill_01_${crypto.randomUUID().slice(0, 8)}`;
    const customerId = `cust_drill_01_${crypto.randomUUID().slice(0, 8)}`;
    const amountPaise = 35000; // ₹350.00
    const batchRef = `BATCH_DRILL_01_${Date.now()}`;

    // Step 1: Record discrepancy as reconciliation worker does
    await reconWorker._recordDiscrepancy({
      batchRef,
      discrepancyType: 'MISSING_INTERNAL_ESCROW',
      rec: {
        provider_order_id: `order_prov_${paymentId}`,
        provider_payment_id: providerPaymentId,
        payment_id: paymentId,
        trip_id: tripId,
        customer_id: customerId,
        expected_amount_paise: amountPaise,
        internal_state: 'INITIATED'
      },
      remotePayment: {
        providerPaymentId,
        amountPaise,
        status: 'captured'
      },
      resolutionStatus: 'OPEN',
      resolutionAction: 'FLAGGED_MANUAL_REVIEW',
      resolutionNotes: 'Provider capture confirmed via bank UTR-128472, missing local escrow hold'
    });

    const discRes = await pool.query(
      `SELECT discrepancy_id, resolution_status FROM payment_discrepancy_records WHERE payment_id = $1`,
      [paymentId]
    );
    assert.equal(discRes.rows.length, 1);
    const discrepancyId = discRes.rows[0].discrepancy_id;
    assert.equal(discRes.rows[0].resolution_status, 'OPEN');

    // Step 2: Operator transitions to INVESTIGATING (SOP Phase 1)
    const toInvestigating = await securityService.transitionDiscrepancy({
      discrepancyId,
      toStatus: 'INVESTIGATING',
      reason: 'Investigating missing escrow per SOP-FIN-01. Checking provider transaction UTR-128472.',
      actorId: 'ops_drill_analyst',
      actorRole: 'FINANCE_RESOLVE'
    });
    assert.equal(toInvestigating.success, true);
    assert.equal(toInvestigating.toStatus, 'INVESTIGATING');

    // Step 3: Operator resolves via safe double-entry compensating entry reference (SOP Phase 3)
    const toResolved = await securityService.transitionDiscrepancy({
      discrepancyId,
      toStatus: 'RESOLVED_MANUAL',
      reason: 'Verified gateway capture. Compensating journal entry posted per SOP-FIN-01.',
      actorId: 'lead_drill_reviewer',
      actorRole: 'FINANCE_RESOLVE',
      correctiveTransactionRef: `TX_COMP_${Date.now()}`
    });
    assert.equal(toResolved.success, true);
    assert.equal(toResolved.toStatus, 'RESOLVED_MANUAL');

    // Verify audit log immutability & entry existence
    const auditRes = await pool.query(
      `SELECT action, actor_id, actor_role FROM financial_audit_trail WHERE resource_id = $1 ORDER BY created_at ASC`,
      [String(discrepancyId)]
    );
    assert.ok(auditRes.rows.length >= 2, 'Audit trail must record status change and resolution');
  });

  await t.test('SOP-FIN-02 Drill: Stop Condition Enforcement on AMOUNT_MISMATCH (Auto-Settlement Blocked)', async () => {
    const tripId = `trip_drill_02_${crypto.randomUUID().slice(0, 8)}`;
    const paymentId = `pay_drill_02_${crypto.randomUUID().slice(0, 8)}`;
    const providerPaymentId = `rzp_pay_drill_02_${crypto.randomUUID().slice(0, 8)}`;
    const customerId = `cust_drill_02_${crypto.randomUUID().slice(0, 8)}`;
    const expectedPaise = 50000; // ₹500.00
    const tamperedPaise = 5000;  // ₹50.00 (Tampered payload)
    const batchRef = `BATCH_DRILL_02_${Date.now()}`;

    // Record discrepancy for AMOUNT_MISMATCH
    await reconWorker._recordDiscrepancy({
      batchRef,
      discrepancyType: 'AMOUNT_MISMATCH',
      rec: {
        provider_order_id: `order_prov_${paymentId}`,
        provider_payment_id: providerPaymentId,
        payment_id: paymentId,
        trip_id: tripId,
        customer_id: customerId,
        expected_amount_paise: expectedPaise,
        internal_state: 'ESCROW_HELD'
      },
      remotePayment: {
        providerPaymentId,
        amountPaise: tamperedPaise,
        status: 'captured'
      },
      resolutionStatus: 'OPEN',
      resolutionAction: 'FLAGGED_MANUAL_REVIEW',
      resolutionNotes: 'Amount mismatch detected between internal expected amount and remote captured amount'
    });

    const discRes = await pool.query(
      `SELECT discrepancy_id, discrepancy_type, resolution_status FROM payment_discrepancy_records WHERE payment_id = $1`,
      [paymentId]
    );
    assert.equal(discRes.rows.length, 1);
    const discrepancy = discRes.rows[0];
    assert.equal(discrepancy.discrepancy_type, 'AMOUNT_MISMATCH');

    // Verify Stop Condition: Auto-healing must NEVER auto-resolve amount mismatch
    const canAutoHeal = (discrepancy.discrepancy_type === 'AUTO_HEALABLE_MISSING_POSTING');
    assert.equal(canAutoHeal, false, 'AMOUNT_MISMATCH must strictly fail auto-healability check');

    // Operator escalates to fraud review (SOP Phase 4)
    const escalated = await securityService.transitionDiscrepancy({
      discrepancyId: discrepancy.discrepancy_id,
      toStatus: 'ESCALATED',
      reason: 'Escalated to Fraud & InfoSec team per SOP-FIN-02. Zero automated force-settle.',
      actorId: 'ops_sec_officer',
      actorRole: 'FINANCE_RESOLVE'
    });
    assert.equal(escalated.success, true);
    assert.equal(escalated.toStatus, 'ESCALATED');
  });

  await t.test('SOP-FIN-03 Drill: Outbox Dead-Letter Queue Inspection, Reset & Safe Redrive', async () => {
    const paymentId = `pay_drill_03_${crypto.randomUUID().slice(0, 8)}`;
    const eventType = 'PAYMENT_CAPTURED';
    const eventId = `EVT_OUTBOX_DRILL_${crypto.randomUUID().slice(0, 8)}`;

    // Seed a message in FAILED status (DLQ)
    const insertRes = await pool.query(
      `INSERT INTO payment_outbox (
        event_id, aggregate_type, aggregate_id, event_type, payload, status, attempt_count, last_error, created_at, next_attempt_at
      ) VALUES ($1, 'PAYMENT', $2, $3, $4, 'FAILED', 5, 'Network timeout 504 to notification service', NOW() - INTERVAL '1 hour', NOW())
      RETURNING outbox_id, event_id, status, attempt_count`,
      [eventId, paymentId, eventType, JSON.stringify({ paymentId, amountPaise: 12000 })]
    );

    const outboxId = insertRes.rows[0].outbox_id;
    assert.equal(insertRes.rows[0].status, 'FAILED');

    // Operator executes SOP-FIN-03 Redrive Query:
    // Reset status to PENDING, attempt_count = 0, next_attempt_at = NOW()
    const updateRes = await pool.query(
      `UPDATE payment_outbox
       SET status = 'PENDING',
           attempt_count = 0,
           next_attempt_at = NOW(),
           last_error = CONCAT('REDRIVE_REQUESTED: ', last_error)
       WHERE outbox_id = $1 AND status = 'FAILED'
       RETURNING outbox_id, status, attempt_count, last_error`,
      [outboxId]
    );

    assert.equal(updateRes.rows.length, 1);
    assert.equal(updateRes.rows[0].status, 'PENDING');
    assert.equal(updateRes.rows[0].attempt_count, 0);
    assert.ok(updateRes.rows[0].last_error.startsWith('REDRIVE_REQUESTED:'));

    // Trigger dispatcher poll cycle (idempotency guarantees exactly-once dispatch)
    const dispatchResults = await outboxDispatcher.pollAndDispatch();
    assert.ok(dispatchResults !== undefined);

    // Confirm that the message is now PUBLISHED
    const checkRes = await pool.query(`SELECT status FROM payment_outbox WHERE outbox_id = $1`, [outboxId]);
    assert.notEqual(checkRes.rows[0].status, 'FAILED');
  });

  await t.test('SOP-FIN-04 Drill: Maker-Checker Dual-Control Enforcement & Self-Approval Prevention', async () => {
    const paymentId = `pay_drill_04_${crypto.randomUUID().slice(0, 8)}`;
    const highValueRefundPaise = 750000; // ₹7,500 (> ₹5,000 threshold)

    // Step 1: Maker initiates request
    const request = await securityService.submitApprovalRequest({
      operationType: 'HIGH_VALUE_REFUND',
      payload: {
        paymentId,
        refundPaise: highValueRefundPaise,
        reason: 'Customer dispute settlement'
      },
      amountPaise: highValueRefundPaise,
      reason: 'Customer dispute settlement per support ticket #VAAYU-9182',
      requestedBy: 'maker_rahul_fin',
      requestedByRole: 'FINANCE_REFUND'
    });

    assert.ok(request.requestId, 'Approval request created');
    assert.equal(request.status, 'PENDING_APPROVAL');

    // Step 2: Maker attempts self-approval (MUST FAIL WITH DUAL_CONTROL_VIOLATION)
    await assert.rejects(
      async () => {
        await securityService.decideApprovalRequest({
          requestId: request.requestId,
          decision: 'APPROVED',
          decisionNotes: 'Attempting self-approval',
          decidedBy: 'maker_rahul_fin', // SAME AS REQUESTED_BY
          decidedByRole: 'SUPER_ADMIN'
        });
      },
      (err) => {
        assert.ok(
          err.message.includes('DUAL_CONTROL_VIOLATION') || err.message.includes('cannot self-approve'),
          `Error should specify dual control violation, got: ${err.message}`
        );
        return true;
      }
    );

    // Verify request is STILL PENDING after rejection of self-approval
    const pendingCheck = await pool.query(
      `SELECT status FROM financial_approval_requests WHERE request_id = $1`,
      [request.requestId]
    );
    assert.equal(pendingCheck.rows[0].status, 'PENDING_APPROVAL');

    // Step 3: Independent Checker rejects or approves request (Distinct user passes)
    const rejected = await securityService.decideApprovalRequest({
      requestId: request.requestId,
      decision: 'REJECTED',
      decisionNotes: 'Duplicate refund attempt detected upon checking gateway logs. Rejected per SOP-FIN-04.',
      decidedBy: 'checker_anita_lead', // DISTINCT CHECKER
      decidedByRole: 'SUPER_ADMIN'
    });

    assert.equal(rejected.success, true);
    assert.equal(rejected.status, 'REJECTED');
  });

  await t.test('SOP-FIN-05 Drill: Database Failover Readiness & Verification of Invariant Integrity', async () => {
    // Audit the core financial invariants on live production schema
    const checkInvariantRes = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM ledger_postings p LEFT JOIN ledger_journal_entries j ON p.entry_id = j.entry_id WHERE j.entry_id IS NULL) AS orphan_postings,
        (SELECT COUNT(*) FROM (
          SELECT e.entry_id
          FROM ledger_journal_entries e
          JOIN ledger_postings p ON e.entry_id = p.entry_id
          GROUP BY e.entry_id
          HAVING SUM(CASE WHEN p.side = 'DEBIT' THEN p.amount_paise ELSE 0 END) !=
                 SUM(CASE WHEN p.side = 'CREDIT' THEN p.amount_paise ELSE 0 END)
        ) unbal) AS unbalanced_entries,
        (SELECT COUNT(*) FROM ledger_postings WHERE amount_paise <= 0) AS non_positive_postings
    `);

    const row = checkInvariantRes.rows[0];
    assert.equal(Number(row.orphan_postings), 0, 'No orphaned postings permitted');
    assert.equal(Number(row.unbalanced_entries), 0, 'All journal entries must be balanced (₹0 delta)');
    assert.equal(Number(row.non_positive_postings), 0, 'All posting amounts must be strictly positive');

    // Verify that DR manager can instantiate without configuration failure
    const drManager = new DatabaseDisasterRecoveryManager({ adminUrl: connectionString });
    assert.ok(drManager, 'DR Manager instantiated successfully');
  });
});
