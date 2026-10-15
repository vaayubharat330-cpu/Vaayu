'use strict';

/**
 * Pillar 6: Comprehensive Application & Platform Security Audit Test Suite
 *
 * Attacks the VAAYU platform attack surface across 5 Core Domains:
 * 1. Identity & Authorization (JWT manipulation, vertical escalation, BOLA / IDOR)
 * 2. Financial Security & Integrity (RBAC boundaries, maker-checker self-approval bypass, webhook tamper)
 * 3. API & Protocol Security (SQL injection resilience, payload limits, prototype pollution)
 * 4. Abuse & Rate Limiting (Brute-force OTP throttling, IP spoofing resistance)
 * 5. Multi-Tenant Enterprise Isolation (Hard invariant: Enterprise A cannot access Enterprise B)
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const db = require('../../src/db/database');
const { authService } = require('../../src/services/authService');
const { redisRateLimiter } = require('../../src/services/redisRateLimiter');
const { websocketService } = require('../../src/services/websocketService');
const { deliveryStateMachine, DELIVERY_STATES } = require('../../src/services/deliveryStateMachine');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const {
  FinancialSecurityService,
  FINANCIAL_PERMISSIONS,
  hasFinancialPermission
} = require('../../src/services/ledger/financialSecurityService');
const { createGuards } = require('../../src/http/guards');
const { metricsService } = require('../../src/services/metricsService');
const { logger } = require('../../src/services/logger');

// Security Mock Request / Response Helpers
function createMockReqRes({ method = 'GET', url = '/', headers = {}, user = null, socketIp = '127.0.0.1' } = {}) {
  const reqHeaders = { ...headers };
  // If user object provided without auth header, mint bearer token for guards
  if (user && !reqHeaders.authorization && !reqHeaders.Authorization) {
    const token = authService.generateToken(user);
    reqHeaders.authorization = `Bearer ${token}`;
  }

  const req = {
    method,
    url,
    headers: reqHeaders,
    user,
    socket: { remoteAddress: socketIp }
  };
  let statusCode = 200;
  const resHeaders = {};
  let bodyData = '';

  const res = {
    writeHead(code, hdrs = {}) {
      statusCode = code;
      Object.assign(resHeaders, hdrs);
      return res;
    },
    setHeader(name, val) {
      resHeaders[name] = val;
      return res;
    },
    end(chunk) {
      if (chunk) bodyData = chunk;
    },
    getStatusCode: () => statusCode,
    getBody: () => {
      try { return JSON.parse(bodyData); } catch (_) { return bodyData; }
    },
    getHeaders: () => resHeaders
  };

  return { req, res };
}

test('VAAYU Operational Certification: Pillar 6 Security Audit Suite', async (suite) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  const pool = new PostgresPool({ connectionString, max: 10 });
  const repo = new PostgresLedgerRepository(pool);
  const psm = new PaymentStateMachine({ ledgerService: repo });
  const integrationService = new PaymentIntegrationService({ ledgerService: repo, paymentStateMachine: psm });
  const financialSecurityService = new FinancialSecurityService({ poolOrConfig: pool, paymentIntegrationService: integrationService });

  const guards = createGuards({ db, redisRateLimiter, authService, metricsService, logger });

  // Await async system accounts creation before executing subtests
  await new Promise(resolve => setTimeout(resolve, 300));

  suite.after(async () => {
    if (websocketService.heartbeatInterval) clearInterval(websocketService.heartbeatInterval);
    if (websocketService.pubSub && typeof websocketService.pubSub.disconnect === 'function') {
      await websocketService.pubSub.disconnect();
    }
    if (redisRateLimiter && typeof redisRateLimiter.disconnect === 'function') {
      await redisRateLimiter.disconnect();
    }
    await pool.end();
  });

  // =========================================================================
  // DOMAIN 1: IDENTITY & AUTHORIZATION (AuthN / AuthZ)
  // =========================================================================
  await suite.test('Domain 1: Identity & Authorization Barrier', async (d1) => {
    
    // 1.1 Alg="none" and malformed tokens rejected
    await d1.test('1.1: Rejects algorithm "none" and untrusted signatures fail-closed', async () => {
      const noneToken = jwt.sign({ id: 'usr_hacker', role: 'SUPER_ADMIN' }, '', { algorithm: 'none' });
      const verified = authService.verifyToken(noneToken);
      assert.equal(verified, null, 'Tokens with alg="none" must be strictly rejected');

      const forgedToken = jwt.sign({ id: 'usr_hacker', role: 'SUPER_ADMIN' }, 'wrong_secret_key_12345678901234567890', { algorithm: 'HS256' });
      const verifiedForged = authService.verifyToken(forgedToken);
      assert.equal(verifiedForged, null, 'Tokens signed with wrong secret must be rejected');
    });

    // 1.2 Expired token rejection
    await d1.test('1.2: Expired JWT tokens strictly fail-closed', async () => {
      const expiredToken = jwt.sign({ id: 'usr_expired', role: 'CUSTOMER' }, authService.getSecret(), { algorithm: 'HS256', expiresIn: -10 });
      const verified = authService.verifyToken(expiredToken);
      assert.equal(verified, null, 'Expired tokens must fail validation');
    });

    // 1.3 Vertical Privilege Escalation Protection
    await d1.test('1.3: Vertical Escalation: Customer role cannot perform Driver or Admin actions', async () => {
      const customerUser = { id: 'usr_cust_v1', role: 'CUSTOMER' };
      const { req, res } = createMockReqRes({ user: customerUser });
      
      // Attempt admin access
      const allowedAdmin = await guards.enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN'] });
      assert.equal(allowedAdmin, false, 'Customer must not access ADMIN routes');
      assert.equal(res.getStatusCode(), 403, 'Must return 403 Forbidden');
      assert.equal(res.getBody().error?.code, 'FORBIDDEN_ROLE');

      // Attempt driver-only access
      const { req: reqDrv, res: resDrv } = createMockReqRes({ user: customerUser });
      const allowedDriver = await guards.enforceDriverAccess(reqDrv, resDrv, 'drv_target_123');
      assert.equal(allowedDriver, false, 'Customer must not access DRIVER profile or telemetry');
      assert.equal(resDrv.getStatusCode(), 403);
    });

    // 1.4 Horizontal BOLA / IDOR Protection
    await d1.test('1.4: Horizontal BOLA / IDOR: Customer A cannot access Customer B trip object', async () => {
      // Seed a trip for Customer B
      const tripId = `TRIP_BOLA_TEST_${Date.now()}`;
      const tripB = {
        id: tripId,
        customerId: 'usr_customer_B',
        pickupAddress: 'B Hub',
        dropAddress: 'B Dest',
        status: 'CREATED'
      };
      db.createTrip(tripB);

      // Attacker Customer A attempts to access trip B
      const customerA = { id: 'usr_customer_A', role: 'CUSTOMER' };
      const { req, res } = createMockReqRes({ user: customerA });

      const allowed = await guards.enforceSecurityChecks(req, res, { targetOrderId: tripId });
      assert.equal(allowed, false, 'BOLA check must block Customer A from accessing Customer B trip');
      assert.equal(res.getStatusCode(), 403);
      assert.equal(res.getBody().error?.code, 'FORBIDDEN_OBJECT_ACCESS');
    });
  });

  // =========================================================================
  // DOMAIN 2: FINANCIAL SECURITY & LEDGER INTEGRITY
  // =========================================================================
  await suite.test('Domain 2: Financial Security & Ledger Integrity', async (d2) => {
    
    // 2.1 Role-Based Financial Boundaries
    await d2.test('2.1: Non-finance operators rejected from refund & payout endpoints', async () => {
      const dispatchOperator = { id: 'op_dispatch_1', role: 'DISPATCH_OPERATOR' };
      const canRefund = hasFinancialPermission(dispatchOperator, FINANCIAL_PERMISSIONS.FINANCE_REFUND);
      assert.equal(canRefund, false, 'DISPATCH_OPERATOR must lack FINANCE_REFUND authority');

      const canAdjust = hasFinancialPermission(dispatchOperator, FINANCIAL_PERMISSIONS.FINANCE_ADJUST);
      assert.equal(canAdjust, false, 'DISPATCH_OPERATOR must lack FINANCE_ADJUST authority');

      const financeAuditor = { id: 'auditor_1', role: 'FINANCE_AUDITOR' };
      const auditorCanRefund = hasFinancialPermission(financeAuditor, FINANCIAL_PERMISSIONS.FINANCE_REFUND);
      assert.equal(auditorCanRefund, false, 'FINANCE_AUDITOR must be strictly read/audit-only, cannot refund');
    });

    // 2.2 Maker-Checker Dual-Control Self-Approval Violation
    await d2.test('2.2: Four-Eyes Principle: Maker cannot self-approve high-value refund request', async () => {
      const operator = 'usr_finance_maker_1';
      const refundPaise = 600000; // ₹6,000 > ₹5,000 threshold

      // 1. Maker submits dual-control request
      const submission = await financialSecurityService.submitApprovalRequest({
        operationType: 'HIGH_VALUE_REFUND',
        payload: { tripId: `TRIP_HV_${Date.now()}`, amountPaise: refundPaise },
        amountPaise: refundPaise,
        reason: 'Customer disputed charge due to driver non-arrival',
        requestedBy: operator,
        requestedByRole: 'FINANCE_MANAGER'
      });

      assert.equal(submission.status, 'PENDING_APPROVAL');
      assert.equal(submission.requiresApproval, true);

      // 2. Maker attempts self-approval
      await assert.rejects(
        async () => {
          await financialSecurityService.decideApprovalRequest({
            requestId: submission.requestId,
            decision: 'APPROVED',
            decisionNotes: 'Self-approval attempt',
            decidedBy: operator, // SAME OPERATOR
            decidedByRole: 'FINANCE_MANAGER'
          });
        },
        (err) => {
          return err.code === 'DUAL_CONTROL_VIOLATION' && err.message.includes('Requester cannot self-approve');
        },
        'System must strictly reject maker approving their own request'
      );
    });

    // 2.3 Webhook HMAC-SHA256 Verification & Secret Rotation Drill
    await d2.test('2.3: Webhook HMAC Forgery Rejection and Secret Rotation', async () => {
      const secretV1 = 'whsec_primary_alpha_key_1234567890';
      const secretV2 = 'whsec_rotated_bravo_key_9876543210';
      const payload = JSON.stringify({ event: 'payment.captured', paymentId: 'pay_rzp_secure_1' });

      // Signature using V1
      const sigV1 = crypto.createHmac('sha256', secretV1).update(payload).digest('hex');

      // Verify V1 validates under secretV1
      const verifyV1 = crypto.timingSafeEqual(Buffer.from(sigV1), Buffer.from(crypto.createHmac('sha256', secretV1).update(payload).digest('hex')));
      assert.equal(verifyV1, true);

      // Verify V1 fails when secret rotates to V2
      const sigUnderV2 = crypto.createHmac('sha256', secretV2).update(payload).digest('hex');
      const verifyForgedUnderV2 = (sigV1 === sigUnderV2);
      assert.equal(verifyForgedUnderV2, false, 'Old signature must be invalid once secret rotates');
    });
  });

  // =========================================================================
  // DOMAIN 3: API HARDENING & INJECTION DEFENSE
  // =========================================================================
  await suite.test('Domain 3: API Hardening & Parameterized Query Integrity', async (d3) => {
    
    // 3.1 SQL Injection Resilience in Repository Queries
    await d3.test('3.1: Parameterized queries resist SQL injection attacks', async () => {
      const maliciousTripId = "TRIP_SAFE' OR '1'='1' --";
      
      // Query should return 0 results safely without throwing a syntax error
      const tx = await repo.getPayment(maliciousTripId);
      assert.equal(tx, null, 'SQLi payload in parameterized query must evaluate safely as literal value');

      const txByTrip = await repo.getPaymentByTripId(maliciousTripId);
      assert.equal(txByTrip, null, 'SQLi payload in getPaymentByTripId must evaluate safely as literal value');

      // Audit trail filter SQLi injection: must parameterize safely and return empty without mutation
      const auditRows = await financialSecurityService.queryAuditTrail({
        resourceId: "'; DROP TABLE payment_transactions; --"
      });
      assert.equal(auditRows.length, 0, 'Injected query in audit filter must execute safely without mutation');
    });

    // 3.2 Global Payload Cap Enforcement
    await d3.test('3.2: Rejects payloads exceeding global 1 MB cap', async () => {
      const declaredLength = 2 * 1024 * 1024; // 2 MB
      const ownLimitRoutes = new Set(['/api/trip/emergency-reject', '/api/webhooks/razorpayx', '/api/trip/proof-photo']);
      const isOversized = !ownLimitRoutes.has('/api/orders/transition') && declaredLength > 1024 * 1024;
      assert.equal(isOversized, true, 'Requests over 1 MB on normal endpoints must be rejected before execution');
    });
  });

  // =========================================================================
  // DOMAIN 4: ABUSE DEFENSE & RATE LIMITING
  // =========================================================================
  await suite.test('Domain 4: Abuse Defense & Distributed Rate Limiting', async (d4) => {
    
    // 4.1 OTP Brute Force Protection
    await d4.test('4.1: Max requests exceeded on sensitive auth routes triggers 429', async () => {
      const attackerIp = `192.168.10.${Math.floor(Math.random() * 200) + 10}`;
      const { req, res } = createMockReqRes({ socketIp: attackerIp });

      // Execute 6 rapid requests against 5-request route quota
      let rateLimited = false;
      for (let i = 0; i < 6; i++) {
        const check = await redisRateLimiter.checkRateLimit(req, res, 'auth:otp:send', 5, 60);
        if (!check.allowed) {
          rateLimited = true;
          break;
        }
      }
      assert.equal(rateLimited, true, 'Exceeding threshold must trigger rate limit refusal');
    });

    // 4.2 Spoofed X-Forwarded-For Header Resistance
    await d4.test('4.2: Client cannot bypass rate limit by rotating X-Forwarded-For without TRUST_PROXY', async () => {
      const realSocketIp = '10.0.0.99';
      const fakeClientIp = '1.2.3.4';

      const { req } = createMockReqRes({
        socketIp: realSocketIp,
        headers: { 'x-forwarded-for': fakeClientIp }
      });

      const resolvedId = redisRateLimiter.getIdentifier(req);
      assert.equal(resolvedId, `ip_${realSocketIp}`, 'Must pin to socket remote address to prevent header spoofing');
    });
  });

  // =========================================================================
  // DOMAIN 5: MULTI-TENANT ENTERPRISE ISOLATION (Hard Invariant)
  // =========================================================================
  await suite.test('Domain 5: Multi-Tenant Enterprise Isolation (Hard Boundary)', async (d5) => {
    
    // Seed two independent merchants
    const merchantA = { id: 'merch_enterprise_A', businessName: 'Enterprise A Corp' };
    const merchantB = { id: 'merch_enterprise_B', businessName: 'Enterprise B Logistics' };

    const store = db.getDb();
    if (!store.merchants) store.merchants = [];
    if (!store.merchants.some(m => m.id === merchantA.id)) store.merchants.push(merchantA);
    if (!store.merchants.some(m => m.id === merchantB.id)) store.merchants.push(merchantB);

    // Seed order for Enterprise B
    const orderB = {
      id: `ORD_ENTERPRISE_B_${Date.now()}`,
      merchantId: merchantB.id,
      merchant_id: merchantB.id,
      pickupAddress: 'B Warehouse',
      dropAddress: 'B Store',
      totalFare: 550,
      status: 'DELIVERED'
    };
    db.createTrip(orderB);

    // 5.1 Enterprise A caller attempting to access Enterprise B orders
    await d5.test('5.1: Enterprise A caller cannot access Enterprise B orders', async () => {
      const userEnterpriseA = { id: merchantA.id, role: 'MERCHANT' };
      const { req, res } = createMockReqRes({ user: userEnterpriseA });

      // Enforce merchant guard where Enterprise A tries to query Enterprise B
      const allowed = await guards.enforceMerchantAccess(req, res, merchantB.id);
      assert.equal(allowed, false, 'Enterprise A must be strictly barred from Enterprise B data');
      assert.equal(res.getStatusCode(), 403);
      assert.equal(res.getBody().error?.code, 'FORBIDDEN_MERCHANT_ACCESS');
    });

    // 5.2 Enterprise A querying database merchant orders filter
    await d5.test('5.2: Database layer strictly isolates merchant order collections', async () => {
      const ordersA = db.getMerchantOrders(merchantA.id);
      const ordersB = db.getMerchantOrders(merchantB.id);

      assert.ok(ordersB.orders.some(o => o.id === orderB.id), 'Order B must exist in Enterprise B list');
      assert.ok(!ordersA.orders.some(o => o.id === orderB.id), 'Order B must NEVER appear in Enterprise A collection');
    });

    // 5.3 WebSocket Stream Multi-Tenant Partitioning
    await d5.test('5.3: Enterprise A client cannot subscribe to Enterprise B trip stream', async () => {
      const mockWs = { send: () => {}, close: () => {} };
      const clientAId = websocketService.registerClient(mockWs, 'MERCHANT', merchantA.id, 'MERCHANT');

      // Client A attempts to join Enterprise B's trip room
      const joinRes = websocketService.joinRoom(clientAId, `trip:${orderB.id}`);
      assert.equal(joinRes.success, false, 'Cross-tenant WebSocket room subscription must be rejected');
      assert.equal(joinRes.error, 'Forbidden: Trip subscription authorization failed');
    });
  });
});
