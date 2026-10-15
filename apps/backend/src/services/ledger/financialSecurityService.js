'use strict';

const crypto = require('crypto');
const { PostgresPool } = require('../../db/postgresClient');
const { metricsService } = require('../metricsService');
const { logger } = require('../logger');

/**
 * Granular Financial RBAC Permissions
 */
const FINANCIAL_PERMISSIONS = Object.freeze({
  FINANCE_VIEW: 'FINANCE_VIEW',           // Read-only view of ledgers, transactions, stats
  FINANCE_RECONCILE: 'FINANCE_RECONCILE', // Trigger or inspect reconciliation runs
  FINANCE_RESOLVE: 'FINANCE_RESOLVE',     // Transition and resolve discrepancy records
  FINANCE_REFUND: 'FINANCE_REFUND',       // Initiate or approve customer refunds
  FINANCE_ADJUST: 'FINANCE_ADJUST',       // Post-settlement dispute fare adjustments
  FINANCE_PAYOUT: 'FINANCE_PAYOUT',       // Driver payout operations
  FINANCE_EXPORT: 'FINANCE_EXPORT',       // Export ledger reports and forensic records
  FINANCE_AUDIT: 'FINANCE_AUDIT',         // Query immutable administrative audit trail
  SUPER_ADMIN: 'SUPER_ADMIN'              // Super-admin master role with unrestricted authority
});

/**
 * Standard Role-to-Permissions Mapping
 */
const ROLE_PERMISSIONS_MAP = Object.freeze({
  SUPER_ADMIN: Object.values(FINANCIAL_PERMISSIONS),
  ADMIN: [
    FINANCIAL_PERMISSIONS.FINANCE_VIEW,
    FINANCIAL_PERMISSIONS.FINANCE_RECONCILE,
    FINANCIAL_PERMISSIONS.FINANCE_RESOLVE,
    FINANCIAL_PERMISSIONS.FINANCE_REFUND,
    FINANCIAL_PERMISSIONS.FINANCE_ADJUST,
    FINANCIAL_PERMISSIONS.FINANCE_PAYOUT,
    FINANCIAL_PERMISSIONS.FINANCE_EXPORT,
    FINANCIAL_PERMISSIONS.FINANCE_AUDIT
  ],
  FINANCE_MANAGER: [
    FINANCIAL_PERMISSIONS.FINANCE_VIEW,
    FINANCIAL_PERMISSIONS.FINANCE_RECONCILE,
    FINANCIAL_PERMISSIONS.FINANCE_RESOLVE,
    FINANCIAL_PERMISSIONS.FINANCE_REFUND,
    FINANCIAL_PERMISSIONS.FINANCE_ADJUST,
    FINANCIAL_PERMISSIONS.FINANCE_PAYOUT,
    FINANCIAL_PERMISSIONS.FINANCE_EXPORT,
    FINANCIAL_PERMISSIONS.FINANCE_AUDIT
  ],
  FINANCE_OPERATOR: [
    FINANCIAL_PERMISSIONS.FINANCE_VIEW,
    FINANCIAL_PERMISSIONS.FINANCE_RECONCILE,
    FINANCIAL_PERMISSIONS.FINANCE_RESOLVE
  ],
  FINANCE_AUDITOR: [
    FINANCIAL_PERMISSIONS.FINANCE_VIEW,
    FINANCIAL_PERMISSIONS.FINANCE_EXPORT,
    FINANCIAL_PERMISSIONS.FINANCE_AUDIT
  ]
});

/**
 * Helper to check whether an operator user has a required permission
 */
function hasFinancialPermission(user, requiredPermission) {
  if (!user) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  if (user.role === requiredPermission) return true;
  if (Array.isArray(user.permissions) && user.permissions.includes(requiredPermission)) return true;
  const mapped = ROLE_PERMISSIONS_MAP[user.role];
  if (Array.isArray(mapped) && mapped.includes(requiredPermission)) return true;
  return false;
}

/**
 * Discrepancy Status Transition Rules
 */
const LEGAL_DISCREPANCY_TRANSITIONS = Object.freeze({
  OPEN: ['INVESTIGATING', 'RESOLVED', 'RESOLVED_MANUAL', 'ESCALATED', 'DISMISSED'],
  INVESTIGATING: ['RESOLVED', 'RESOLVED_MANUAL', 'ESCALATED', 'DISMISSED', 'OPEN'],
  ESCALATED: ['INVESTIGATING', 'RESOLVED', 'RESOLVED_MANUAL', 'DISMISSED'],
  RESOLVED: [],        // Terminal
  RESOLVED_MANUAL: [], // Terminal
  AUTO_RESOLVED: [],   // Terminal
  DISMISSED: []        // Terminal
});

/**
 * VAAYU FINANCIAL SECURITY & OPERATIONAL CONTROLS SERVICE (Phase F.6)
 * 
 * Provides:
 * 1. Granular Financial RBAC enforcement.
 * 2. Immutable PostgreSQL Administrative Audit Trail with SHA-256 state hashing.
 * 3. Four-Eyes / Dual-Control Approval Workflow (Maker-Checker) for high-risk operations.
 * 4. Discrepancy Resolution & Investigation Lifecycle Workflow.
 * 5. Forensic Financial Reporting directly derived from the PostgreSQL double-entry ledger.
 */
class FinancialSecurityService {
  constructor({
    poolOrConfig,
    paymentIntegrationService,
    fourEyesThresholdPaise = 500000, // ₹5,000 threshold for dual-control refund
    loggerInstance = null
  } = {}) {
    if (poolOrConfig && typeof poolOrConfig.query === 'function') {
      this.pool = poolOrConfig;
    } else {
      const connStr = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
      this.pool = new PostgresPool({ connectionString: connStr });
    }

    this.integrationService = paymentIntegrationService;
    this.fourEyesThresholdPaise = Number(fourEyesThresholdPaise);
    this.logger = loggerInstance || logger;
  }

  // ===========================================================================
  // 1. IMMUTABLE ADMINISTRATIVE FINANCIAL AUDIT TRAIL
  // ===========================================================================

  /**
   * Record an immutable entry in the administrative audit log
   */
  async recordAudit({
    actorId,
    actorRole,
    action,
    resourceType,
    resourceId,
    reason = null,
    requestId = null,
    idempotencyKey = null,
    beforeState = null,
    afterState = null,
    metadata = {},
    ipAddress = null,
    userAgent = null
  }) {
    const auditId = `AUDIT_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const beforeHash = beforeState ? crypto.createHash('sha256').update(JSON.stringify(beforeState)).digest('hex') : null;
    const afterHash = afterState ? crypto.createHash('sha256').update(JSON.stringify(afterState)).digest('hex') : null;

    await this.pool.query(`
      INSERT INTO financial_audit_trail (
        audit_id, actor_id, actor_role, action, resource_type, resource_id,
        reason, request_id, idempotency_key, before_state_hash, after_state_hash,
        metadata, ip_address, user_agent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW());
    `, [
      auditId,
      actorId || 'SYSTEM',
      actorRole || 'SYSTEM',
      action,
      resourceType,
      resourceId,
      reason,
      requestId,
      idempotencyKey,
      beforeHash,
      afterHash,
      JSON.stringify(metadata),
      ipAddress,
      userAgent
    ]);

    metricsService.increment('financial_audit_records_total');
    return { auditId, beforeHash, afterHash };
  }

  /**
   * Query the forensic audit trail with pagination and filters
   */
  async queryAuditTrail({
    actorId = null,
    action = null,
    resourceType = null,
    resourceId = null,
    limit = 50,
    offset = 0
  } = {}) {
    let querySql = `
      SELECT audit_id, actor_id, actor_role, action, resource_type, resource_id,
             reason, request_id, idempotency_key, before_state_hash, after_state_hash,
             metadata, ip_address, user_agent, created_at
      FROM financial_audit_trail
      WHERE 1=1
    `;
    const params = [];

    if (actorId) {
      params.push(actorId);
      querySql += ` AND actor_id = $${params.length}`;
    }
    if (action) {
      params.push(action);
      querySql += ` AND action = $${params.length}`;
    }
    if (resourceType) {
      params.push(resourceType);
      querySql += ` AND resource_type = $${params.length}`;
    }
    if (resourceId) {
      params.push(resourceId);
      querySql += ` AND resource_id = $${params.length}`;
    }

    params.push(Number(limit) || 50);
    querySql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    params.push(Number(offset) || 0);
    querySql += ` OFFSET $${params.length}`;

    const res = await this.pool.query(querySql, params);
    return res.rows;
  }

  // ===========================================================================
  // 2. FOUR-EYES DUAL-CONTROL APPROVAL WORKFLOW (MAKER-CHECKER)
  // ===========================================================================

  /**
   * Determine if an operation requires maker-checker dual approval
   */
  requiresDualControl(operationType, amountPaise = 0) {
    if (operationType === 'MANUAL_ADJUSTMENT' || operationType === 'BALANCE_CORRECTION') {
      return true;
    }
    if ((operationType === 'HIGH_VALUE_REFUND' || operationType === 'REFUND') && Number(amountPaise) >= this.fourEyesThresholdPaise) {
      return true;
    }
    return false;
  }

  /**
   * Maker submits a financial request requiring dual approval
   */
  async submitApprovalRequest({
    operationType,
    payload = {},
    amountPaise = 0,
    reason,
    requestedBy,
    requestedByRole,
    requestId = null,
    idempotencyKey = null
  }) {
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error('A detailed reason is strictly required when requesting dual-control approval.');
    }

    const reqId = requestId || `REQ_APPR_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const safeAmount = Number(amountPaise) || 0;

    await this.pool.query(`
      INSERT INTO financial_approval_requests (
        request_id, operation_type, status, payload, amount_paise,
        threshold_paise, reason, requested_by, requested_by_role,
        execution_idempotency_key, created_at, updated_at
      ) VALUES ($1, $2, 'PENDING_APPROVAL', $3, $4, $5, $6, $7, $8, $9, NOW(), NOW());
    `, [
      reqId,
      operationType,
      JSON.stringify(payload),
      safeAmount,
      this.fourEyesThresholdPaise,
      reason,
      requestedBy,
      requestedByRole,
      idempotencyKey
    ]);

    await this.recordAudit({
      actorId: requestedBy,
      actorRole: requestedByRole,
      action: 'APPROVAL_REQUESTED',
      resourceType: 'APPROVAL_REQUEST',
      resourceId: reqId,
      reason,
      idempotencyKey,
      metadata: { operationType, amountPaise: safeAmount }
    });

    metricsService.increment('financial_approvals_requested_total');

    return {
      success: true,
      requestId: reqId,
      status: 'PENDING_APPROVAL',
      requiresApproval: true,
      operationType,
      amountPaise: safeAmount
    };
  }

  /**
   * Checker approves or rejects a pending dual-control request
   */
  async decideApprovalRequest({
    requestId,
    decision, // 'APPROVED' or 'REJECTED'
    decisionNotes = null,
    decidedBy,
    decidedByRole
  }) {
    if (decision !== 'APPROVED' && decision !== 'REJECTED') {
      throw new Error(`Decision must be 'APPROVED' or 'REJECTED'. Received: ${decision}`);
    }

    const client = await (this.pool.pool ? this.pool.pool.connect() : this.pool.connect());
    try {
      await client.query('BEGIN');

      const reqRes = await client.query(`
        SELECT * FROM financial_approval_requests
        WHERE request_id = $1
        FOR UPDATE;
      `, [requestId]);

      if (reqRes.rows.length === 0) {
        throw new Error(`Approval request ${requestId} not found.`);
      }

      const requestRow = reqRes.rows[0];
      if (requestRow.status !== 'PENDING_APPROVAL') {
        throw new Error(`Approval request is already in status ${requestRow.status}. Cannot re-decide.`);
      }

      // STRICT FOUR-EYES INVARIANT: Requester cannot self-approve their own request!
      if (requestRow.requested_by === decidedBy) {
        const err = new Error('DUAL_CONTROL_VIOLATION: Requester cannot self-approve their own financial request.');
        err.code = 'DUAL_CONTROL_VIOLATION';
        throw err;
      }

      // Check approver permission
      const requiredPerm = (requestRow.operation_type === 'HIGH_VALUE_REFUND' || requestRow.operation_type === 'REFUND')
        ? FINANCIAL_PERMISSIONS.FINANCE_REFUND
        : FINANCIAL_PERMISSIONS.FINANCE_ADJUST;

      if (!hasFinancialPermission({ role: decidedByRole }, requiredPerm) && decidedByRole !== 'SUPER_ADMIN') {
        const err = new Error(`FORBIDDEN: Checker lacks ${requiredPerm} permission.`);
        err.code = 'FORBIDDEN';
        throw err;
      }

      if (decision === 'REJECTED') {
        await client.query(`
          UPDATE financial_approval_requests
          SET status = 'REJECTED',
              approved_by = $1,
              approved_by_role = $2,
              decided_at = NOW(),
              decision_notes = $3,
              updated_at = NOW()
          WHERE request_id = $4;
        `, [decidedBy, decidedByRole, decisionNotes, requestId]);

        await this.recordAudit({
          actorId: decidedBy,
          actorRole: decidedByRole,
          action: 'APPROVAL_REJECTED',
          resourceType: 'APPROVAL_REQUEST',
          resourceId: requestId,
          reason: decisionNotes,
          metadata: { operationType: requestRow.operation_type }
        });

        await client.query('COMMIT');
        metricsService.increment('financial_approvals_rejected_total');
        return { success: true, requestId, status: 'REJECTED' };
      }

      // DECISION IS APPROVED: Execute financial command
      let executionResult = null;
      const payload = typeof requestRow.payload === 'string' ? JSON.parse(requestRow.payload) : requestRow.payload;

      if (this.integrationService) {
        if (requestRow.operation_type === 'HIGH_VALUE_REFUND' || requestRow.operation_type === 'REFUND') {
          executionResult = await this.integrationService.refundTrip(payload);
        } else if (requestRow.operation_type === 'MANUAL_ADJUSTMENT' || requestRow.operation_type === 'ADJUSTMENT') {
          executionResult = await this.integrationService.adjustSettledTrip(payload);
        } else {
          executionResult = { success: true, note: 'Approved operational override' };
        }
      } else {
        executionResult = { success: true, note: 'Approved without bound integration service' };
      }

      if (!executionResult || !executionResult.success) {
        const errMsg = executionResult?.error?.message || executionResult?.error || 'Financial execution failed';
        throw new Error(`EXECUTION_FAILED: ${errMsg}`);
      }

      const finalStatus = 'EXECUTED';

      await client.query(`
        UPDATE financial_approval_requests
        SET status = 'EXECUTED',
            approved_by = $1,
            approved_by_role = $2,
            decided_at = NOW(),
            decision_notes = $3,
            execution_result = $4,
            updated_at = NOW()
        WHERE request_id = $5;
      `, [
        decidedBy,
        decidedByRole,
        decisionNotes,
        JSON.stringify(executionResult),
        requestId
      ]);

      await this.recordAudit({
        actorId: decidedBy,
        actorRole: decidedByRole,
        action: 'APPROVAL_EXECUTED',
        resourceType: 'APPROVAL_REQUEST',
        resourceId: requestId,
        reason: decisionNotes,
        afterState: executionResult,
        metadata: { operationType: requestRow.operation_type, status: finalStatus }
      });

      await client.query('COMMIT');
      metricsService.increment('financial_approvals_executed_total');

      return {
        success: executionResult.success,
        requestId,
        status: finalStatus,
        executionResult
      };

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      if (client && typeof client.release === 'function') {
        client.release();
      }
    }
  }

  /**
   * List approval requests with status filter
   */
  async getApprovalRequests({ status = null, requestedBy = null, limit = 50, offset = 0 } = {}) {
    let sql = 'SELECT * FROM financial_approval_requests WHERE 1=1';
    const params = [];
    if (status) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }
    if (requestedBy) {
      params.push(requestedBy);
      sql += ` AND requested_by = $${params.length}`;
    }
    params.push(Number(limit) || 50);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    params.push(Number(offset) || 0);
    sql += ` OFFSET $${params.length}`;

    const res = await this.pool.query(sql, params);
    return res.rows;
  }

  // ===========================================================================
  // 3. DISCREPANCY RESOLUTION WORKFLOW
  // ===========================================================================

  /**
   * Transition discrepancy status through the investigation workflow
   */
  async transitionDiscrepancy({
    discrepancyId,
    toStatus,
    reason,
    actorId,
    actorRole,
    correctiveTransactionRef = null,
    metadata = {}
  }) {
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error('A detailed reason is required to transition discrepancy status.');
    }

    if (!hasFinancialPermission({ role: actorRole }, FINANCIAL_PERMISSIONS.FINANCE_RESOLVE) && actorRole !== 'SUPER_ADMIN') {
      const err = new Error('FORBIDDEN: FINANCE_RESOLVE permission required.');
      err.code = 'FORBIDDEN';
      throw err;
    }

    const client = await (this.pool.pool ? this.pool.pool.connect() : this.pool.connect());
    try {
      await client.query('BEGIN');

      const discRes = await client.query(`
        SELECT * FROM payment_discrepancy_records
        WHERE discrepancy_id = $1
        FOR UPDATE;
      `, [discrepancyId]);

      if (discRes.rows.length === 0) {
        throw new Error(`Discrepancy record ${discrepancyId} not found.`);
      }

      const current = discRes.rows[0];
      const fromStatus = current.resolution_status;

      const allowedTransitions = LEGAL_DISCREPANCY_TRANSITIONS[fromStatus] || [];
      if (!allowedTransitions.includes(toStatus)) {
        throw new Error(`Illegal discrepancy transition from ${fromStatus} to ${toStatus}. Allowed: [${allowedTransitions.join(', ')}]`);
      }

      const isTerminal = (toStatus === 'RESOLVED' || toStatus === 'RESOLVED_MANUAL' || toStatus === 'DISMISSED');
      const actionName = correctiveTransactionRef ? 'CORRECTIVE_TRANSACTION' : (toStatus === 'DISMISSED' ? 'OPERATOR_DISMISSED' : `TRANSITION_TO_${toStatus}`);

      await client.query(`
        UPDATE payment_discrepancy_records
        SET resolution_status = $1,
            resolution_action = $2,
            resolution_notes = $3,
            resolved_at = CASE WHEN $4::boolean THEN NOW() ELSE resolved_at END,
            updated_at = NOW()
        WHERE discrepancy_id = $5;
      `, [toStatus, actionName, reason, isTerminal, discrepancyId]);

      // Insert into immutable history
      await client.query(`
        INSERT INTO payment_discrepancy_history (
          discrepancy_id, from_status, to_status, actor_id, actor_role,
          reason, corrective_transaction_ref, before_state, after_state,
          metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW());
      `, [
        discrepancyId,
        fromStatus,
        toStatus,
        actorId,
        actorRole,
        reason,
        correctiveTransactionRef,
        JSON.stringify({ status: fromStatus, notes: current.resolution_notes }),
        JSON.stringify({ status: toStatus, notes: reason }),
        JSON.stringify(metadata)
      ]);

      // Record administrative audit
      await this.recordAudit({
        actorId,
        actorRole,
        action: isTerminal ? 'DISCREPANCY_RESOLVED' : 'DISCREPANCY_STATUS_CHANGED',
        resourceType: 'DISCREPANCY',
        resourceId: String(discrepancyId),
        reason,
        metadata: { fromStatus, toStatus, correctiveTransactionRef }
      });

      await client.query('COMMIT');
      metricsService.increment('discrepancy_transitions_total');

      return {
        success: true,
        discrepancyId,
        fromStatus,
        toStatus,
        reason,
        isTerminal
      };

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      if (client && typeof client.release === 'function') {
        client.release();
      }
    }
  }

  /**
   * Get discrepancy transition history
   */
  async getDiscrepancyHistory(discrepancyId) {
    const res = await this.pool.query(`
      SELECT history_id, discrepancy_id, from_status, to_status,
             actor_id, actor_role, reason, corrective_transaction_ref,
             created_at
      FROM payment_discrepancy_history
      WHERE discrepancy_id = $1
      ORDER BY created_at ASC;
    `, [discrepancyId]);
    return res.rows;
  }

  // ===========================================================================
  // 4. POSTGRESQL LEDGER-DERIVED FORENSIC REPORTING
  // ===========================================================================

  /**
   * Generate forensic report directly from PostgreSQL immutable ledger and payment state
   */
  async generateForensicReport({ fromDate = null, toDate = null } = {}) {
    // 1. Transaction volume and status breakdown
    const txRes = await this.pool.query(`
      SELECT 
        COUNT(*)::integer AS total_transactions,
        COALESCE(SUM(amount_paise), 0)::bigint AS gmv_paise,
        COALESCE(SUM(CASE WHEN state = 'ESCROWED' THEN escrow_paise ELSE 0 END), 0)::bigint AS active_escrow_paise,
        COALESCE(SUM(CASE WHEN state = 'SETTLED' THEN amount_paise ELSE 0 END), 0)::bigint AS settled_fare_paise,
        COALESCE(SUM(driver_earnings_paise), 0)::bigint AS driver_settled_paise,
        COALESCE(SUM(commission_paise), 0)::bigint AS platform_commission_paise,
        COALESCE(SUM(gst_paise), 0)::bigint AS gst_liability_paise,
        COALESCE(SUM(refunded_paise), 0)::bigint AS total_refunded_paise,
        COALESCE(SUM(adjustment_paise), 0)::bigint AS total_dispute_adjusted_paise
      FROM payment_transactions;
    `);

    // 2. Discrepancy Breakdown
    const discRes = await this.pool.query(`
      SELECT 
        COUNT(*)::integer AS total_discrepancies,
        COUNT(CASE WHEN resolution_status = 'OPEN' THEN 1 END)::integer AS open_count,
        COUNT(CASE WHEN resolution_status = 'INVESTIGATING' THEN 1 END)::integer AS investigating_count,
        COUNT(CASE WHEN resolution_status IN ('RESOLVED', 'RESOLVED_MANUAL') THEN 1 END)::integer AS resolved_count,
        COUNT(CASE WHEN resolution_status = 'ESCALATED' THEN 1 END)::integer AS escalated_count,
        COUNT(CASE WHEN resolution_status = 'AUTO_RESOLVED' THEN 1 END)::integer AS auto_resolved_count
      FROM payment_discrepancy_records;
    `);

    // 3. Authoritative Double-Entry Balance Check
    const ledgerBalanceRes = await this.pool.query(`
      SELECT 
        COALESCE(SUM(debit_paise), 0)::bigint AS total_debits_paise,
        COALESCE(SUM(credit_paise), 0)::bigint AS total_credits_paise
      FROM ledger_accounts;
    `);

    // 4. Pending Approval Requests
    const apprRes = await this.pool.query(`
      SELECT 
        COUNT(*)::integer AS total_approval_requests,
        COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END)::integer AS pending_approvals,
        COUNT(CASE WHEN status = 'EXECUTED' THEN 1 END)::integer AS executed_approvals,
        COUNT(CASE WHEN status = 'REJECTED' THEN 1 END)::integer AS rejected_approvals
      FROM financial_approval_requests;
    `);

    const txStats = txRes.rows[0];
    const discStats = discRes.rows[0];
    const ledgerStats = ledgerBalanceRes.rows[0];
    const apprStats = apprRes.rows[0];

    const isDoubleEntryBalanced = (Number(ledgerStats.total_debits_paise) === Number(ledgerStats.total_credits_paise));

    return {
      success: true,
      generatedAt: new Date().toISOString(),
      sourceOfTruth: 'POSTGRESQL_IMMUTABLE_DOUBLE_ENTRY_LEDGER',
      isDoubleEntryBalanced,
      ledger: {
        totalDebitsPaise: Number(ledgerStats.total_debits_paise),
        totalCreditsPaise: Number(ledgerStats.total_credits_paise),
        imbalancePaise: Math.abs(Number(ledgerStats.total_debits_paise) - Number(ledgerStats.total_credits_paise))
      },
      volume: {
        totalTransactions: txStats.total_transactions,
        gmvPaise: Number(txStats.gmv_paise),
        activeEscrowPaise: Number(txStats.active_escrow_paise),
        settledFarePaise: Number(txStats.settled_fare_paise),
        totalRefundedPaise: Number(txStats.total_refunded_paise),
        totalDisputeAdjustedPaise: Number(txStats.total_dispute_adjusted_paise)
      },
      settlementDistribution: {
        driverSettledPaise: Number(txStats.driver_settled_paise),
        platformCommissionPaise: Number(txStats.platform_commission_paise),
        gstLiabilityPaise: Number(txStats.gst_liability_paise)
      },
      discrepancies: discStats,
      approvals: apprStats
    };
  }
}

module.exports = {
  FinancialSecurityService,
  FINANCIAL_PERMISSIONS,
  ROLE_PERMISSIONS_MAP,
  LEGAL_DISCREPANCY_TRANSITIONS,
  hasFinancialPermission
};
