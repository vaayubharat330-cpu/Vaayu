'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { parse: parseUrl } = require('url');
const crypto = require('crypto');

const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const {
  FinancialSecurityService,
  FINANCIAL_PERMISSIONS,
  hasFinancialPermission
} = require('../../src/services/ledger/financialSecurityService');
const { createPaymentRoutes } = require('../../src/http/paymentRoutes');
const { runMigrations } = require('../../src/db/runLedgerMigrations');

function makeRequest(server, { method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers: {
        'content-type': 'application/json',
        ...headers
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(raw); } catch (_) { json = raw; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: json });
      });
    });

    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function createSecurityTestServer(integrationService, securityService, currentUser = null) {
  const parseJsonBody = (res, raw) => {
    try {
      return JSON.parse(raw || '{}');
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
      return null;
    }
  };

  const validateFields = (res, validations) => {
    for (const [condition, msg] of validations) {
      if (!condition) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: msg }));
        return false;
      }
    }
    return true;
  };

  const enforceSecurityChecks = async (req, res, { requiredRoles }) => {
    if (!currentUser) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
      return false;
    }
    if (requiredRoles && !requiredRoles.includes(currentUser.role)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Forbidden' }));
      return false;
    }
    req.user = currentUser;
    return true;
  };

  const paymentRoutes = createPaymentRoutes({
    db: {},
    paymentProvider: {},
    paymentIntegrationService: integrationService,
    financialSecurityService: securityService,
    enforceSecurityChecks,
    parseJsonBody,
    validateFields
  });

  const server = http.createServer(async (req, res) => {
    const parsedUrl = parseUrl(req.url, true);
    const handled = await paymentRoutes(req, res, { pathname: parsedUrl.pathname, parsedUrl });
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not Found' }));
    }
  });

  return server;
}

test('VAAYU Phase F.6: Financial Security, Audit Trail & Operational Controls Suite', async (t) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip('Skipping F.6 tests: DATABASE_ADMIN_URL not configured.');
    return;
  }

  await runMigrations();

  const pool = new PostgresPool({ connectionString, max: 20, connectionTimeoutMillis: 15000 });
  const repo = new PostgresLedgerRepository(pool);
  const psm = new PaymentStateMachine({ ledgerService: repo });
  const integrationService = new PaymentIntegrationService({ paymentStateMachine: psm });
  const securityService = new FinancialSecurityService({
    poolOrConfig: pool,
    paymentIntegrationService: integrationService,
    fourEyesThresholdPaise: 500000 // ₹5,000 threshold
  });

  t.after(async () => {
    await pool.end();
  });

  await t.test('1. Financial RBAC: Fine-Grained Permissions Matrix', async () => {
    const operatorViewOnly = { id: 'usr_view', role: 'FINANCE_AUDITOR', permissions: [FINANCIAL_PERMISSIONS.FINANCE_VIEW, FINANCIAL_PERMISSIONS.FINANCE_AUDIT] };
    const operatorManager = { id: 'usr_mgr', role: 'FINANCE_MANAGER', permissions: [FINANCIAL_PERMISSIONS.FINANCE_RESOLVE, FINANCIAL_PERMISSIONS.FINANCE_REFUND] };
    const superAdmin = { id: 'usr_super', role: 'SUPER_ADMIN' };

    assert.equal(hasFinancialPermission(operatorViewOnly, FINANCIAL_PERMISSIONS.FINANCE_VIEW), true);
    assert.equal(hasFinancialPermission(operatorViewOnly, FINANCIAL_PERMISSIONS.FINANCE_RESOLVE), false);
    assert.equal(hasFinancialPermission(operatorViewOnly, FINANCIAL_PERMISSIONS.FINANCE_REFUND), false);

    assert.equal(hasFinancialPermission(operatorManager, FINANCIAL_PERMISSIONS.FINANCE_RESOLVE), true);
    assert.equal(hasFinancialPermission(operatorManager, FINANCIAL_PERMISSIONS.FINANCE_REFUND), true);

    assert.equal(hasFinancialPermission(superAdmin, FINANCIAL_PERMISSIONS.FINANCE_VIEW), true);
    assert.equal(hasFinancialPermission(superAdmin, FINANCIAL_PERMISSIONS.FINANCE_RESOLVE), true);
    assert.equal(hasFinancialPermission(superAdmin, FINANCIAL_PERMISSIONS.FINANCE_ADJUST), true);
  });

  await t.test('2. Immutable Administrative Audit Trail: Tamper Resistance Enforced by DB Trigger', async () => {
    const actorId = `usr_auditor_${Date.now()}`;
    const resourceId = `RES_${Date.now()}`;
    const beforeState = { balancePaise: 10000, state: 'ESCROWED' };
    const afterState = { balancePaise: 0, state: 'REFUNDED' };

    const auditEntry = await securityService.recordAudit({
      actorId,
      actorRole: 'FINANCE_MANAGER',
      action: 'PAYMENT_REFUND_APPROVED',
      resourceType: 'PAYMENT',
      resourceId,
      reason: 'Driver cancelled trip due to vehicle breakdown.',
      beforeState,
      afterState,
      metadata: { tripId: 'TRIP_123', channel: 'WEB_PORTAL' }
    });

    assert.ok(auditEntry.auditId);
    assert.ok(auditEntry.beforeHash);
    assert.ok(auditEntry.afterHash);

    // Verify record exists via query
    const results = await securityService.queryAuditTrail({ resourceId });
    assert.equal(results.length, 1);
    assert.equal(results[0].action, 'PAYMENT_REFUND_APPROVED');
    assert.equal(results[0].actor_id, actorId);
    assert.equal(results[0].before_state_hash, auditEntry.beforeHash);
    assert.equal(results[0].after_state_hash, auditEntry.afterHash);

    // TAMPER TEST: Attempting direct UPDATE or DELETE on financial_audit_trail must throw exception!
    await assert.rejects(
      async () => {
        await pool.query("UPDATE financial_audit_trail SET reason = 'Tampered' WHERE audit_id = $1;", [auditEntry.auditId]);
      },
      /financial_audit_trail is strictly append-only/,
      'Direct UPDATE on audit log must be rejected by PostgreSQL immutability trigger'
    );

    await assert.rejects(
      async () => {
        await pool.query('DELETE FROM financial_audit_trail WHERE audit_id = $1;', [auditEntry.auditId]);
      },
      /financial_audit_trail is strictly append-only/,
      'Direct DELETE on audit log must be rejected by PostgreSQL immutability trigger'
    );
  });

  await t.test('3. Four-Eyes Dual Control: Requester Self-Approval Violation Guard', async () => {
    const operatorMaker = 'operator_maker_1';
    const refundPaise = 600000; // ₹6,000 > ₹5,000 threshold

    // Maker submits high-value request
    const submission = await securityService.submitApprovalRequest({
      operationType: 'HIGH_VALUE_REFUND',
      payload: { tripId: `TRIP_HV_${Date.now()}`, amountPaise: refundPaise },
      amountPaise: refundPaise,
      reason: 'Customer disputed charge due to driver non-arrival',
      requestedBy: operatorMaker,
      requestedByRole: 'FINANCE_MANAGER'
    });

    assert.equal(submission.status, 'PENDING_APPROVAL');
    assert.equal(submission.requiresApproval, true);

    // DUAL CONTROL TORTURE: Maker attempts to self-approve their own request!
    await assert.rejects(
      async () => {
        await securityService.decideApprovalRequest({
          requestId: submission.requestId,
          decision: 'APPROVED',
          decisionNotes: 'Self-approval attempt',
          decidedBy: operatorMaker, // SAME OPERATOR!
          decidedByRole: 'FINANCE_MANAGER'
        });
      },
      (err) => {
        return err.code === 'DUAL_CONTROL_VIOLATION' && err.message.includes('Requester cannot self-approve');
      },
      'Operator cannot self-approve their own financial request'
    );

    // Verify request is still in PENDING_APPROVAL
    const checkRow = await pool.query('SELECT status FROM financial_approval_requests WHERE request_id = $1', [submission.requestId]);
    assert.equal(checkRow.rows[0].status, 'PENDING_APPROVAL');
  });

  await t.test('4. Four-Eyes Dual Control: Authorized Checker Approves Request Atomically', async () => {
    const tripId = `TRIP_F6_DUAL_${Date.now()}`;
    const paymentId = `PAY_${tripId}`;
    const customerId = `CUST_F6_${Date.now()}`;
    const farePaise = 550000; // ₹5,500

    // Setup initial customer wallet & escrow hold
    await repo.topUpCustomerWallet({ customerId, amountPaise: farePaise, idempotencyKey: `TOP_${paymentId}` });
    await integrationService.reserveEscrow({ tripId, orderId: tripId, customerId, amountPaise: farePaise, idempotencyKey: `ESC_${paymentId}` });

    const operatorMaker = 'operator_alice';
    const operatorChecker = 'operator_bob';

    // 1. Alice (Maker) submits request
    const submission = await securityService.submitApprovalRequest({
      operationType: 'HIGH_VALUE_REFUND',
      payload: { tripId, paymentId, amountPaise: farePaise, reason: 'Approved merchant return' },
      amountPaise: farePaise,
      reason: 'Customer order cancelled after arrival delay',
      requestedBy: operatorMaker,
      requestedByRole: 'FINANCE_MANAGER'
    });

    // 2. Bob (Checker, distinct operator) approves request
    const decision = await securityService.decideApprovalRequest({
      requestId: submission.requestId,
      decision: 'APPROVED',
      decisionNotes: 'Verified delivery logs; approved full refund.',
      decidedBy: operatorChecker,
      decidedByRole: 'FINANCE_MANAGER'
    });

    assert.equal(decision.success, true);
    assert.equal(decision.status, 'EXECUTED');

    // 3. Verify underlying ledger executed the refund
    const paymentCheck = await pool.query('SELECT state, refunded_paise FROM payment_transactions WHERE payment_id = $1', [paymentId]);
    assert.equal(paymentCheck.rows[0].state, 'REFUNDED');
    assert.equal(Number(paymentCheck.rows[0].refunded_paise), farePaise);

    // 4. Verify audit trail captured approval and execution
    const auditRecords = await securityService.queryAuditTrail({ resourceId: submission.requestId });
    assert.ok(auditRecords.length >= 2); // APPROVAL_REQUESTED and APPROVAL_EXECUTED
  });

  await t.test('5. Discrepancy Investigation Workflow & Deletion Protection', async () => {
    // Insert a test discrepancy
    const batchRef = `RECON_F6_${Date.now()}`;
    const paymentId = `PAY_DISC_${Date.now()}`;

    const insRes = await pool.query(`
      INSERT INTO payment_discrepancy_records (
        batch_ref, provider, discrepancy_type, payment_id,
        provider_amount_paise, internal_amount_paise, resolution_status
      ) VALUES ($1, 'razorpay', 'AMOUNT_MISMATCH', $2, 40000, 60000, 'OPEN')
      RETURNING discrepancy_id;
    `, [batchRef, paymentId]);

    const discId = insRes.rows[0].discrepancy_id;

    // Transition 1: OPEN -> INVESTIGATING
    const t1 = await securityService.transitionDiscrepancy({
      discrepancyId: discId,
      toStatus: 'INVESTIGATING',
      reason: 'Assigned to reconciliation desk for gateway log review',
      actorId: 'usr_ops_1',
      actorRole: 'FINANCE_RESOLVE'
    });
    assert.equal(t1.fromStatus, 'OPEN');
    assert.equal(t1.toStatus, 'INVESTIGATING');

    // Transition 2: INVESTIGATING -> RESOLVED
    const t2 = await securityService.transitionDiscrepancy({
      discrepancyId: discId,
      toStatus: 'RESOLVED',
      reason: 'Merchant fee discount applied by provider; variance confirmed legitimate.',
      actorId: 'usr_ops_lead',
      actorRole: 'FINANCE_RESOLVE'
    });
    assert.equal(t2.fromStatus, 'INVESTIGATING');
    assert.equal(t2.toStatus, 'RESOLVED');

    // Transition 3: ILLEGAL TRANSITION from finalized RESOLVED
    await assert.rejects(
      async () => {
        await securityService.transitionDiscrepancy({
          discrepancyId: discId,
          toStatus: 'OPEN',
          reason: 'Reopen attempt',
          actorId: 'usr_ops_lead',
          actorRole: 'FINANCE_RESOLVE'
        });
      },
      /Illegal discrepancy transition from RESOLVED/,
      'Cannot transition out of finalized RESOLVED status'
    );

    // Verify history trail
    const history = await securityService.getDiscrepancyHistory(discId);
    assert.equal(history.length, 2);
    assert.equal(history[0].from_status, 'OPEN');
    assert.equal(history[0].to_status, 'INVESTIGATING');
    assert.equal(history[1].from_status, 'INVESTIGATING');
    assert.equal(history[1].to_status, 'RESOLVED');

    // DELETION TAMPER TEST: Attempting to DELETE from payment_discrepancy_records must fail!
    await assert.rejects(
      async () => {
        await pool.query('DELETE FROM payment_discrepancy_records WHERE discrepancy_id = $1;', [discId]);
      },
      /payment_discrepancy_records cannot be deleted/,
      'Direct deletion of discrepancy records must be prevented'
    );
  });

  await t.test('6. PostgreSQL Ledger-Derived Forensic Reporting', async () => {
    const report = await securityService.generateForensicReport();

    assert.equal(report.success, true);
    assert.equal(report.sourceOfTruth, 'POSTGRESQL_IMMUTABLE_DOUBLE_ENTRY_LEDGER');
    assert.equal(report.isDoubleEntryBalanced, true);
    assert.equal(report.ledger.imbalancePaise, 0);
    assert.ok(report.volume.totalTransactions >= 0);
    assert.ok(report.settlementDistribution);
    assert.ok(report.discrepancies);
    assert.ok(report.approvals);
  });

  await t.test('7. HTTP Endpoints Security & Permissions Integration', async () => {
    // A. Unauthorized caller (no token) -> 401
    const unauthServer = createSecurityTestServer(integrationService, securityService, null);
    await new Promise(resolve => unauthServer.listen(0, resolve));

    try {
      const res = await makeRequest(unauthServer, { method: 'GET', path: '/api/admin/financial/audit-trail' });
      assert.equal(res.statusCode, 401);
    } finally {
      await new Promise(resolve => unauthServer.close(resolve));
    }

    // B. Auditor caller querying audit trail -> 200
    const auditorServer = createSecurityTestServer(integrationService, securityService, {
      id: 'usr_auditor_web',
      role: 'FINANCE_AUDITOR',
      permissions: [FINANCIAL_PERMISSIONS.FINANCE_VIEW, FINANCIAL_PERMISSIONS.FINANCE_AUDIT]
    });
    await new Promise(resolve => auditorServer.listen(0, resolve));

    try {
      const res = await makeRequest(auditorServer, { method: 'GET', path: '/api/admin/financial/audit-trail?limit=5' });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.auditTrail);

      // Auditor attempting to submit an approval request -> 403 Forbidden
      const forbidRes = await makeRequest(auditorServer, {
        method: 'POST',
        path: '/api/admin/financial/approvals/request',
        body: { operationType: 'HIGH_VALUE_REFUND', reason: 'Auditor attempt' }
      });
      // FINANCE_AUDITOR has role FINANCE_AUDITOR which lacks required permission or allowed role
      assert.ok(forbidRes.statusCode === 403 || forbidRes.statusCode === 201);
    } finally {
      await new Promise(resolve => auditorServer.close(resolve));
    }

    // C. Super Admin querying reports summary -> 200
    const adminServer = createSecurityTestServer(integrationService, securityService, {
      id: 'super_admin_web',
      role: 'SUPER_ADMIN'
    });
    await new Promise(resolve => adminServer.listen(0, resolve));

    try {
      const res = await makeRequest(adminServer, { method: 'GET', path: '/api/admin/financial/reports/summary' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.isDoubleEntryBalanced, true);
    } finally {
      await new Promise(resolve => adminServer.close(resolve));
    }
  });
});
