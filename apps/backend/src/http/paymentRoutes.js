// Payment gateway & PSM Double-Entry Ledger routes:
// 1. Legacy Gateway (Razorpay order create, signature verify, history)
// 2. VAAYU Payment Integration (PSM Double-Entry Escrow, Settle, Refund, Dispute, Adjust, Expire)
'use strict';

const { paymentIntegrationService: defaultIntegrationService } = require('../services/ledger/paymentIntegrationService');
const {
  FinancialSecurityService,
  FINANCIAL_PERMISSIONS,
  hasFinancialPermission
} = require('../services/ledger/financialSecurityService');

function sendPaymentResponse(res, result, successStatusCode = 200) {
  if (result.success) {
    const statusCode = result.idempotentReplay ? 200 : successStatusCode;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  let statusCode = 400;
  const errorCode = result.error?.code;
  if (errorCode === 'PAYMENT_NOT_FOUND') {
    statusCode = 404;
  } else if (
    errorCode === 'ILLEGAL_STATE_TRANSITION' ||
    errorCode === 'PAYMENT_ALREADY_SETTLED' ||
    errorCode === 'PAYMENT_EXPIRED' ||
    errorCode === 'DUPLICATE_IDEMPOTENCY_KEY' ||
    errorCode === 'IDEMPOTENCY_PAYLOAD_MISMATCH' ||
    errorCode === 'PAYMENT_VERSION_CONFLICT' ||
    errorCode === 'DISPUTE_ALREADY_ADJUSTED'
  ) {
    statusCode = 409;
  } else if (
    errorCode === 'REFUND_LIMIT_EXCEEDED' ||
    errorCode === 'INVALID_ADJUSTMENT_ALLOCATION' ||
    errorCode === 'ADJUSTMENT_EXCEEDS_EARNINGS' ||
    errorCode === 'ADJUSTMENT_EXCEEDS_FARE'
  ) {
    statusCode = 422;
  } else if (errorCode === 'UNAUTHORIZED') {
    statusCode = 401;
  } else if (errorCode === 'FORBIDDEN_ROLE') {
    statusCode = 403;
  }

  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify(result));
}

function createPaymentRoutes({
  db,
  paymentProvider,
  paymentIntegrationService: injectedService,
  paymentIngestionService,
  financialSecurityService: injectedSecurityService,
  enforceSecurityChecks,
  parseJsonBody,
  validateFields
}) {
  const integrationService = injectedService || defaultIntegrationService;
  let securityService = injectedSecurityService;
  if (!securityService) {
    try {
      securityService = new FinancialSecurityService({ paymentIntegrationService: integrationService });
    } catch (_) {
      securityService = null;
    }
  }

  const enforceFinancialPermission = async (req, res, requiredPerm) => {
    if (!await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FINANCE_OPERATOR', 'FINANCE_MANAGER', 'FINANCE_AUDITOR'] })) {
      return false;
    }
    if (req.user?.role === 'SUPER_ADMIN' || req.user?.role === 'ADMIN') {
      return true;
    }
    if (!hasFinancialPermission(req.user, requiredPerm)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: `Forbidden: user lacks required financial permission ${requiredPerm}`,
        requiredPermission: requiredPerm
      }));
      return false;
    }
    return true;
  };

  return async function handlePaymentRoute(req, res, { pathname, parsedUrl }) {

    // =========================================================================
    // VAAYU PSM LEDGER ENDPOINTS (/api/payments/*)
    // =========================================================================

    // 1. Reserve Escrow Hold
    if (pathname === '/api/payments/escrow' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN', 'MERCHANT'] })) return;

        if (!validateFields(res, [
          [data.tripId && typeof data.tripId === 'string', 'tripId is required'],
          [Number.isSafeInteger(Number(data.amountPaise)) && Number(data.amountPaise) > 0, 'amountPaise must be a positive integer in paise']
        ])) return;

        const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || data.idempotencyKey || null;
        const customerId = data.customerId || req.user?.id;

        const result = await integrationService.reserveEscrow({
          tripId: data.tripId,
          orderId: data.orderId || data.tripId,
          customerId,
          amountPaise: Number(data.amountPaise),
          idempotencyKey
        });

        return sendPaymentResponse(res, result, 201);
      });
      return true;
    }

    // 2. Settle Trip to Driver
    if (pathname === '/api/payments/settle' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'DISPATCH_OPERATOR'] })) return;

        if (!validateFields(res, [
          [data.tripId && typeof data.tripId === 'string', 'tripId is required'],
          [data.driverId && typeof data.driverId === 'string', 'driverId is required']
        ])) return;

        const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || data.idempotencyKey || null;
        const result = await integrationService.settleTrip({
          tripId: data.tripId,
          driverId: data.driverId,
          amountPaise: data.amountPaise !== undefined ? Number(data.amountPaise) : null,
          platformCommissionPaise: data.platformCommissionPaise !== undefined ? Number(data.platformCommissionPaise) : null,
          idempotencyKey
        });

        return sendPaymentResponse(res, result, 200);
      });
      return true;
    }

    // 3. Refund or Fare Adjustment
    if (pathname === '/api/payments/refund' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN', 'SUPPORT_AGENT'] })) return;

        if (!validateFields(res, [
          [(data.tripId && typeof data.tripId === 'string') || (data.paymentId && typeof data.paymentId === 'string'), 'tripId or paymentId is required']
        ])) return;

        const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || data.idempotencyKey || null;
        const result = await integrationService.refundTrip({
          tripId: data.tripId,
          paymentId: data.paymentId,
          amountPaise: data.amountPaise !== undefined ? Number(data.amountPaise) : null,
          reason: data.reason || 'Trip refund / fare adjustment',
          idempotencyKey
        });

        return sendPaymentResponse(res, result, 200);
      });
      return true;
    }

    // 4. Initiate Dispute
    if (pathname === '/api/payments/dispute' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN', 'SUPPORT_AGENT'] })) return;

        if (!validateFields(res, [
          [(data.tripId && typeof data.tripId === 'string') || (data.paymentId && typeof data.paymentId === 'string'), 'tripId or paymentId is required'],
          [data.disputeId && typeof data.disputeId === 'string', 'disputeId is required']
        ])) return;

        const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || data.idempotencyKey || null;
        const result = await integrationService.disputePayment({
          tripId: data.tripId,
          paymentId: data.paymentId,
          disputeId: data.disputeId,
          reason: data.reason || 'Customer post-settlement dispute',
          idempotencyKey
        });

        return sendPaymentResponse(res, result, 200);
      });
      return true;
    }

    // 5. Adjust Disputed Payment
    if (pathname === '/api/payments/adjust' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return;

        if (!validateFields(res, [
          [(data.tripId && typeof data.tripId === 'string') || (data.paymentId && typeof data.paymentId === 'string'), 'tripId or paymentId is required'],
          [data.disputeId && typeof data.disputeId === 'string', 'disputeId is required'],
          [data.allocations && typeof data.allocations === 'object', 'allocations object is required']
        ])) return;

        const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || data.idempotencyKey || null;
        const result = await integrationService.adjustPayment({
          tripId: data.tripId,
          paymentId: data.paymentId,
          disputeId: data.disputeId,
          adjustmentPaise: data.adjustmentPaise !== undefined ? Number(data.adjustmentPaise) : null,
          allocations: data.allocations,
          reason: data.reason || 'Dispute financial adjustment',
          idempotencyKey
        });

        return sendPaymentResponse(res, result, 200);
      });
      return true;
    }

    // 6. Expire Abandoned Escrow (Internal Only)
    if (pathname === '/api/payments/expire' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        // Internal worker check: X-Internal-Service header or ADMIN/SUPER_ADMIN role
        const internalService = req.headers['x-internal-service'] || req.headers['X-Internal-Service'];
        const isInternalWorker = (internalService === 'dispatch-worker');
        if (!isInternalWorker) {
          if (!await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return;
        }

        if (!validateFields(res, [
          [(data.tripId && typeof data.tripId === 'string') || (data.paymentId && typeof data.paymentId === 'string'), 'tripId or paymentId is required']
        ])) return;

        const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || data.idempotencyKey || null;
        const result = await integrationService.expirePayment({
          tripId: data.tripId,
          paymentId: data.paymentId,
          reason: data.reason || 'Dispatch search timed out',
          idempotencyKey
        });

        return sendPaymentResponse(res, result, 200);
      });
      return true;
    }

    // 7. Payment Status Query
    if (pathname === '/api/payments/status' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN', 'DISPATCH_OPERATOR'] })) return true;
      const tripId = parsedUrl.query.tripId || parsedUrl.query.trip_id;
      if (!tripId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'INVALID_PARAMS', message: 'tripId is required' } }));
        return true;
      }

      const result = await integrationService.getPaymentStatus(tripId);
      res.writeHead(result.success ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return true;
    }

    // =========================================================================
    // VAAYU PHASE E: ADMIN FINANCIAL REPORTING & AUDIT ENDPOINTS
    // =========================================================================

    // 8. Admin System-Wide Ledger Reconciliation
    if ((pathname === '/api/admin/financial/reconciliation' || pathname === '/api/payments/admin/reconciliation') && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return true;
      const result = integrationService.getReconciliation();
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return true;
    }

    // 9. Admin Comprehensive Ledger Health & Balances Audit
    if ((pathname === '/api/admin/financial/ledger-audit' || pathname === '/api/payments/admin/ledger-audit') && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return true;
      const result = integrationService.getLedgerAudit();
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return true;
    }

    // 10. Admin Financial Transactions Query
    if ((pathname === '/api/admin/financial/transactions' || pathname === '/api/payments/admin/transactions') && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return true;
      const filters = {
        tripId: parsedUrl.query.tripId || parsedUrl.query.trip_id,
        state: parsedUrl.query.state,
        customerId: parsedUrl.query.customerId || parsedUrl.query.customer_id,
        driverId: parsedUrl.query.driverId || parsedUrl.query.driver_id,
        limit: parsedUrl.query.limit,
        offset: parsedUrl.query.offset
      };
      const result = integrationService.queryTransactions(filters);
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return true;
    }

    // 11. Admin Financial Stats & GMV Overview
    if ((pathname === '/api/admin/financial/stats' || pathname === '/api/payments/admin/stats') && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return true;
      const result = integrationService.getFinancialStats();
      res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return true;
    }

    // =========================================================================
    // VAAYU PHASE F.6: FINANCIAL SECURITY, AUDIT TRAIL & OPERATIONAL CONTROLS
    // =========================================================================

    // 12. Forensic Administrative Audit Trail
    if (pathname === '/api/admin/financial/audit-trail' && req.method === 'GET') {
      if (!await enforceFinancialPermission(req, res, FINANCIAL_PERMISSIONS.FINANCE_AUDIT)) return true;
      if (!securityService) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Financial security service not available' }));
        return true;
      }
      const records = await securityService.queryAuditTrail({
        actorId: parsedUrl.query.actorId || parsedUrl.query.actor_id,
        action: parsedUrl.query.action,
        resourceType: parsedUrl.query.resourceType || parsedUrl.query.resource_type,
        resourceId: parsedUrl.query.resourceId || parsedUrl.query.resource_id,
        limit: parsedUrl.query.limit,
        offset: parsedUrl.query.offset
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: records.length, auditTrail: records }));
      return true;
    }

    // 13. Ledger-Derived Forensic Reporting
    if (pathname === '/api/admin/financial/reports/summary' && req.method === 'GET') {
      if (!await enforceFinancialPermission(req, res, FINANCIAL_PERMISSIONS.FINANCE_VIEW)) return true;
      if (!securityService) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Financial security service not available' }));
        return true;
      }
      const report = await securityService.generateForensicReport();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
      return true;
    }

    // 14. Dual-Control Approval: Submit Request (Maker)
    if (pathname === '/api/admin/financial/approvals/request' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceFinancialPermission(req, res, FINANCIAL_PERMISSIONS.FINANCE_VIEW)) return;
        if (!securityService) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Financial security service not available' }));
        }

        if (!validateFields(res, [
          [data.operationType && typeof data.operationType === 'string', 'operationType is required'],
          [data.reason && typeof data.reason === 'string', 'reason is required']
        ])) return;

        try {
          const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || data.idempotencyKey || null;
          const result = await securityService.submitApprovalRequest({
            operationType: data.operationType,
            payload: data.payload || {},
            amountPaise: data.amountPaise || 0,
            reason: data.reason,
            requestedBy: req.user?.id || 'admin',
            requestedByRole: req.user?.role || 'ADMIN',
            idempotencyKey
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return true;
    }

    // 15. Dual-Control Approval: Decide Request (Checker)
    const approvalDecideMatch = pathname.match(/^\/api\/admin\/financial\/approvals\/([^/]+)\/decide$/);
    if (approvalDecideMatch && req.method === 'POST') {
      const requestId = decodeURIComponent(approvalDecideMatch[1]);
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceFinancialPermission(req, res, FINANCIAL_PERMISSIONS.FINANCE_VIEW)) return;
        if (!securityService) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Financial security service not available' }));
        }

        if (!validateFields(res, [
          [data.decision && (data.decision === 'APPROVED' || data.decision === 'REJECTED'), "decision must be 'APPROVED' or 'REJECTED'"]
        ])) return;

        try {
          const result = await securityService.decideApprovalRequest({
            requestId,
            decision: data.decision,
            decisionNotes: data.notes || data.reason || null,
            decidedBy: req.user?.id || 'admin',
            decidedByRole: req.user?.role || 'ADMIN'
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(result));
        } catch (err) {
          const status = (err.code === 'DUAL_CONTROL_VIOLATION' || err.code === 'FORBIDDEN') ? 403 : 400;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: err.message, code: err.code }));
        }
      });
      return true;
    }

    // 16. Dual-Control Approval: Query Requests
    if (pathname === '/api/admin/financial/approvals' && req.method === 'GET') {
      if (!await enforceFinancialPermission(req, res, FINANCIAL_PERMISSIONS.FINANCE_VIEW)) return true;
      if (!securityService) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Financial security service not available' }));
        return true;
      }
      const requests = await securityService.getApprovalRequests({
        status: parsedUrl.query.status,
        requestedBy: parsedUrl.query.requestedBy,
        limit: parsedUrl.query.limit,
        offset: parsedUrl.query.offset
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: requests.length, requests }));
      return true;
    }

    // 17. Discrepancy Investigation Workflow: Transition Status
    const discrepancyTransMatch = pathname.match(/^\/api\/admin\/financial\/discrepancies\/([^/]+)\/transition$/);
    if (discrepancyTransMatch && req.method === 'POST') {
      const discrepancyId = Number(discrepancyTransMatch[1]);
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceFinancialPermission(req, res, FINANCIAL_PERMISSIONS.FINANCE_RESOLVE)) return;
        if (!securityService) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Financial security service not available' }));
        }

        if (!validateFields(res, [
          [data.toStatus && typeof data.toStatus === 'string', 'toStatus is required'],
          [data.reason && typeof data.reason === 'string', 'reason is required']
        ])) return;

        try {
          const result = await securityService.transitionDiscrepancy({
            discrepancyId,
            toStatus: data.toStatus,
            reason: data.reason,
            actorId: req.user?.id || 'admin',
            actorRole: req.user?.role || 'ADMIN',
            correctiveTransactionRef: data.correctiveTransactionRef || null,
            metadata: data.metadata || {}
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(result));
        } catch (err) {
          const status = err.code === 'FORBIDDEN' ? 403 : 409;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: err.message, code: err.code }));
        }
      });
      return true;
    }

    // 18. Discrepancy Investigation Workflow: Query History
    const discrepancyHistMatch = pathname.match(/^\/api\/admin\/financial\/discrepancies\/([^/]+)\/history$/);
    if (discrepancyHistMatch && req.method === 'GET') {
      const discrepancyId = Number(discrepancyHistMatch[1]);
      if (!await enforceFinancialPermission(req, res, FINANCIAL_PERMISSIONS.FINANCE_VIEW)) return true;
      if (!securityService) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Financial security service not available' }));
        return true;
      }
      const history = await securityService.getDiscrepancyHistory(discrepancyId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, discrepancyId, history }));
      return true;
    }

    // =========================================================================
    // LEGACY RAZORPAY GATEWAY ENDPOINTS (/api/payment/*)
    // =========================================================================

    if (pathname === '/api/payment/create-order' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'], targetOrderId: data.bookingId || null })) return;
        if (!validateFields(res, [
          [Number.isFinite(Number(data.amount)) && Number(data.amount) > 0 && Number(data.amount) <= 1000000, 'amount must be a positive number up to 10,00,000'],
          [data.currency === undefined || data.currency === 'INR', 'currency must be INR'],
        ])) return;
        try {
          const externalOrder = await paymentProvider.createOrder({ amount: data.amount, currency: data.currency || 'INR', receipt: data.bookingId || `${req.user.id}_${Date.now()}`, notes: { userId: String(req.user.id), purpose: String(data.purpose || 'TRIP_FARE') } });
          const order = db.createPaymentOrder ? db.createPaymentOrder(req.user.id, Number(data.amount), data.purpose, data.bookingId, externalOrder) : { success: false, error: 'Payment persistence is unavailable.' };
          res.writeHead(order.success ? 201 : 500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(order));
        } catch (error) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: error.message, providerConfigured: paymentProvider.configured }));
        }
      });
      return true;
    }

    if (pathname === '/api/payment/verify-signature' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'] })) return;
        const orderId = data.order_id || data.razorpay_order_id;
        const paymentId = data.payment_id || data.razorpay_payment_id;
        const signature = data.signature || data.razorpay_signature;
        const signatureValid = paymentProvider.verifySignature(orderId, paymentId, signature);
        if (!signatureValid) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid payment signature or payment provider is not configured.' })); }
        const transaction = db.getPaymentByOrder ? db.getPaymentByOrder(orderId) : null;
        if (!transaction || (req.user.role === 'CUSTOMER' && transaction.userId !== req.user.id)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Payment order not found for this account.' }));
        }
        let remotePayment;
        try { remotePayment = await paymentProvider.getPaymentStatus(paymentId); }
        catch (error) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Could not confirm payment with Razorpay: ${error.message}` }));
        }
        if (!remotePayment.isPaid || remotePayment.orderId !== orderId || remotePayment.amount !== Math.round(Number(transaction.amount) * 100) || remotePayment.currency !== transaction.currency) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Razorpay payment is not captured or does not match the order amount/currency.', providerStatus: remotePayment.status }));
        }
        const verified = db.verifyPaymentSignature ? db.verifyPaymentSignature(orderId, paymentId, signature, true) : { success: false, error: 'Payment persistence is unavailable.' };
        res.writeHead(verified.success ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(verified));
      });
      return true;
    }

    // =========================================================================
    // VAAYU PROVIDER INGESTION WEBHOOK ENDPOINT (/api/payments/webhook/*)
    // =========================================================================
    if (pathname.startsWith('/api/payments/webhook/') && req.method === 'POST') {
      const providerParam = pathname.replace('/api/payments/webhook/', '').trim().toLowerCase();
      let rawBody = '';
      req.on('data', chunk => { rawBody += chunk; });
      req.on('end', async () => {
        const signature = req.headers['x-razorpay-signature'] ||
                          req.headers['x-webhook-signature'] ||
                          req.headers['x-signature'] || null;

        if (paymentIngestionService) {
          const ingestResult = await paymentIngestionService.ingestWebhook({
            providerName: providerParam,
            rawBody,
            signature
          });

          const statusCode = ingestResult.success ? 200 : (
            ingestResult.code === 'UNAUTHENTICATED_WEBHOOK' || ingestResult.code === 'INVALID_SIGNATURE' ? 401 :
            ingestResult.code === 'UNKNOWN_PROVIDER' ? 404 :
            ingestResult.code === 'AMOUNT_MISMATCH' || ingestResult.code === 'CURRENCY_MISMATCH' || ingestResult.code === 'MAPPING_NOT_FOUND' ? 422 : 400
          );

          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(ingestResult));
        }

        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Payment ingestion service not configured.' }));
      });
      return true;
    }

    // =========================================================================
    // VAAYU FINANCIAL TRACE RECONSTRUCTION & ANOMALIES (/api/admin/financial/trace)
    // =========================================================================
    if (pathname === '/api/admin/financial/trace' && req.method === 'GET') {
      if (!await enforceFinancialPermission(req, res, FINANCIAL_PERMISSIONS.FINANCE_AUDIT)) return true;

      const { FinancialTraceReconstructor } = require('../services/ledger/financialTraceReconstructor');
      const tracePool = integrationService?.psm?.ledger?.pool || integrationService?.ledgerService?.pool;
      if (!tracePool) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Ledger database connection not configured for trace reconstruction.' }));
        return true;
      }

      const reconstructor = new FinancialTraceReconstructor(tracePool);
      const trace = await reconstructor.reconstruct({
        paymentId: parsedUrl.query.payment_id || parsedUrl.query.paymentId || null,
        tripId: parsedUrl.query.trip_id || parsedUrl.query.tripId || null,
        requestId: parsedUrl.query.request_id || parsedUrl.query.requestId || null,
        entryId: parsedUrl.query.entry_id || parsedUrl.query.entryId || null,
        eventId: parsedUrl.query.event_id || parsedUrl.query.eventId || null,
        providerEventId: parsedUrl.query.provider_event_id || parsedUrl.query.providerEventId || null,
        discrepancyId: parsedUrl.query.discrepancy_id || parsedUrl.query.discrepancyId || null
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, trace }));
      return true;
    }

    if (pathname === '/api/admin/financial/anomalies' && req.method === 'GET') {
      if (!await enforceFinancialPermission(req, res, FINANCIAL_PERMISSIONS.FINANCE_AUDIT)) return true;

      const { FinancialTraceReconstructor } = require('../services/ledger/financialTraceReconstructor');
      const tracePool = integrationService?.psm?.ledger?.pool || integrationService?.ledgerService?.pool;
      if (!tracePool) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Ledger database connection not configured for anomaly scanning.' }));
        return true;
      }

      const reconstructor = new FinancialTraceReconstructor(tracePool);
      const diagnostics = await reconstructor.scanOperationalAnomalies();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, diagnostics }));
      return true;
    }

    if (pathname === '/api/payment/history' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'] })) return true;
      const userId = req.user.role === 'CUSTOMER' ? req.user.id : (parsedUrl.query.user_id || req.user.id);
      const history = db.getPaymentHistory ? db.getPaymentHistory(userId) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, transactions: history }));
      return true;
    }

    return false;
  };
}

module.exports = { createPaymentRoutes, sendPaymentResponse };
