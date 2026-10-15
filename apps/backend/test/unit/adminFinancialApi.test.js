'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { parse: parseUrl } = require('url');

const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');
const { createPaymentRoutes } = require('../../src/http/paymentRoutes');

class MemoryLedgerRepository {
  constructor() {
    this.state = {
      schemaVersion: 1,
      sequence: 0,
      accounts: {},
      journalEntries: [],
      idempotency: {}
    };
  }
  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }
  replace(next) {
    this.state = JSON.parse(JSON.stringify(next));
  }
}

function createTestServer(integrationService, currentUser = { id: 'usr_admin_1', role: 'ADMIN' }) {
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

test('VAAYU Phase E: Admin Financial Reporting & Audit Test Suite', async (t) => {
  let repo;
  let ledgerService;
  let psm;
  let integrationService;

  const setupServices = () => {
    repo = new MemoryLedgerRepository();
    ledgerService = new LedgerService({ repository: repo });
    psm = new PaymentStateMachine({
      ledgerService,
      commissionConfig: { commissionBps: 1000, gstBps: 1800 }
    });
    integrationService = new PaymentIntegrationService({ paymentStateMachine: psm, ledgerService });
  };

  await t.test('1. RBAC Security Checks on Admin Financial Endpoints', async () => {
    setupServices();

    // A. Unauthenticated (no user)
    const unauthServer = createTestServer(integrationService, null);
    await new Promise(resolve => unauthServer.listen(0, resolve));

    try {
      const res = await makeRequest(unauthServer, { method: 'GET', path: '/api/admin/financial/reconciliation' });
      assert.strictEqual(res.statusCode, 401, 'Unauthenticated access should be rejected with 401');
    } finally {
      await new Promise(resolve => unauthServer.close(resolve));
    }

    // B. Customer Role (forbidden)
    const customerServer = createTestServer(integrationService, { id: 'cust_1', role: 'CUSTOMER' });
    await new Promise(resolve => customerServer.listen(0, resolve));

    try {
      const res1 = await makeRequest(customerServer, { method: 'GET', path: '/api/admin/financial/reconciliation' });
      assert.strictEqual(res1.statusCode, 403, 'Customer role must get 403 on reconciliation');

      const res2 = await makeRequest(customerServer, { method: 'GET', path: '/api/admin/financial/ledger-audit' });
      assert.strictEqual(res2.statusCode, 403, 'Customer role must get 403 on ledger-audit');

      const res3 = await makeRequest(customerServer, { method: 'GET', path: '/api/admin/financial/transactions' });
      assert.strictEqual(res3.statusCode, 403, 'Customer role must get 403 on transactions');

      const res4 = await makeRequest(customerServer, { method: 'GET', path: '/api/admin/financial/stats' });
      assert.strictEqual(res4.statusCode, 403, 'Customer role must get 403 on stats');
    } finally {
      await new Promise(resolve => customerServer.close(resolve));
    }
  });

  await t.test('2. GET /api/admin/financial/reconciliation Invariant Verification', async () => {
    setupServices();
    const server = createTestServer(integrationService, { id: 'admin_1', role: 'ADMIN' });
    await new Promise(resolve => server.listen(0, resolve));

    try {
      // 1. Initial empty state reconciliation
      let res = await makeRequest(server, { method: 'GET', path: '/api/admin/financial/reconciliation' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.reconciliation.ok, true);
      assert.strictEqual(res.body.reconciliation.problems.length, 0);
      assert.strictEqual(res.body.reconciliation.balanced, true);

      // 2. Perform transactions: Top-up, Escrow, Settle
      await psm.topUpCustomerWallet({ customerId: 'CUST_A', amountPaise: 50000, idempotencyKey: 'TOP_1' });
      await integrationService.reserveEscrow({ tripId: 'TRIP_1', customerId: 'CUST_A', amountPaise: 30000 });
      await integrationService.settleTrip({ tripId: 'TRIP_1', driverId: 'DRV_1', amountPaise: 30000 });

      // 3. Reconcile after activity
      res = await makeRequest(server, { method: 'GET', path: '/api/admin/financial/reconciliation' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.reconciliation.ok, true);
      assert.strictEqual(res.body.reconciliation.problems.length, 0);
      assert.strictEqual(res.body.reconciliation.balanced, true);
      assert.strictEqual(res.body.reconciliation.journalEntriesCount, 3);
      assert.strictEqual(res.body.reconciliation.totalDebitsPaise, res.body.reconciliation.totalCreditsPaise);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('3. GET /api/admin/financial/ledger-audit Balance & GST Breakdown', async () => {
    setupServices();
    const server = createTestServer(integrationService, { id: 'admin_1', role: 'ADMIN' });
    await new Promise(resolve => server.listen(0, resolve));

    try {
      // Top-up ₹1000
      await psm.topUpCustomerWallet({ customerId: 'CUST_B', amountPaise: 100000, idempotencyKey: 'TOP_B' });
      
      // Trip fare: ₹300 (30,000 paise)
      // 10% commission: ₹30.00 (3,000 paise)
      // 18% GST: ₹5.40 (540 paise)
      // Driver earnings: ₹264.60 (26,460 paise)
      await integrationService.reserveEscrow({ tripId: 'TRIP_AUDIT_1', customerId: 'CUST_B', amountPaise: 30000 });
      await integrationService.settleTrip({ tripId: 'TRIP_AUDIT_1', driverId: 'DRV_AUDIT', amountPaise: 30000 });

      const res = await makeRequest(server, { method: 'GET', path: '/api/admin/financial/ledger-audit' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);

      const audit = res.body.audit;
      // System accounts verification
      assert.strictEqual(audit.systemAccounts.cashExternal.balancePaise, 100000);
      assert.strictEqual(audit.systemAccounts.platformCommission.balancePaise, 3000);
      assert.strictEqual(audit.systemAccounts.platformGst.balancePaise, 540);
      assert.strictEqual(audit.systemAccounts.escrowPlatform.balancePaise, 0);

      // Aggregated accounts
      assert.strictEqual(audit.aggregatedAccounts.customerWallets.totalBalancePaise, 70000); // 100000 - 30000
      assert.strictEqual(audit.aggregatedAccounts.driverEarnings.totalBalancePaise, 26460);

      // Invariants
      assert.strictEqual(audit.invariants.debitsEqualCredits, true);
      assert.strictEqual(audit.invariants.accountingEquationSatisfied, true);
      // Assets (100,000) = Liabilities (70,000 wallet + 26,460 driver + 540 GST) + Revenue (3,000 Commission)
      assert.strictEqual(audit.invariants.totalAssetsPaise, 100000);
      assert.strictEqual(audit.invariants.totalLiabilitiesPaise, 70000 + 26460 + 540);
      assert.strictEqual(audit.invariants.totalEquityRevenuePaise, 3000);

      // Statutory GST Compliance
      assert.strictEqual(audit.statutoryGst.commissionPaise, 3000);
      assert.strictEqual(audit.statutoryGst.gstPaise, 540);
      assert.strictEqual(audit.statutoryGst.ratioCompliant, true);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('4. GET /api/admin/financial/transactions Querying & Filtering', async () => {
    setupServices();
    const server = createTestServer(integrationService, { id: 'admin_1', role: 'ADMIN' });
    await new Promise(resolve => server.listen(0, resolve));

    try {
      await psm.topUpCustomerWallet({ customerId: 'CUST_FILTER', amountPaise: 200000, idempotencyKey: 'TOP_F' });

      // Create 3 trips with different states
      // Trip 1: SETTLED
      await integrationService.reserveEscrow({ tripId: 'TRIP_TX_1', customerId: 'CUST_FILTER', amountPaise: 40000 });
      await integrationService.settleTrip({ tripId: 'TRIP_TX_1', driverId: 'DRV_F1', amountPaise: 40000 });

      // Trip 2: REFUNDED
      await integrationService.reserveEscrow({ tripId: 'TRIP_TX_2', customerId: 'CUST_FILTER', amountPaise: 25000 });
      await integrationService.refundTrip({ tripId: 'TRIP_TX_2', amountPaise: 25000, reason: 'Test cancel' });

      // Trip 3: ESCROWED
      await integrationService.reserveEscrow({ tripId: 'TRIP_TX_3', customerId: 'CUST_FILTER', amountPaise: 15000 });

      // A. Query all transactions
      let res = await makeRequest(server, { method: 'GET', path: '/api/admin/financial/transactions' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.total, 3);
      assert.strictEqual(res.body.count, 3);

      // B. Filter by state=SETTLED
      res = await makeRequest(server, { method: 'GET', path: '/api/admin/financial/transactions?state=SETTLED' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.count, 1);
      assert.strictEqual(res.body.transactions[0].tripId, 'TRIP_TX_1');
      assert.strictEqual(res.body.transactions[0].state, 'SETTLED');

      // C. Filter by state=REFUNDED
      res = await makeRequest(server, { method: 'GET', path: '/api/admin/financial/transactions?state=REFUNDED' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.count, 1);
      assert.strictEqual(res.body.transactions[0].tripId, 'TRIP_TX_2');

      // D. Filter by specific tripId
      res = await makeRequest(server, { method: 'GET', path: '/api/admin/financial/transactions?tripId=TRIP_TX_3' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.count, 1);
      assert.strictEqual(res.body.transactions[0].tripId, 'TRIP_TX_3');
      assert.strictEqual(res.body.transactions[0].state, 'ESCROWED');

      // E. Pagination (limit=1, offset=1)
      res = await makeRequest(server, { method: 'GET', path: '/api/admin/financial/transactions?limit=1&offset=1' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.count, 1);
      assert.strictEqual(res.body.total, 3);
      assert.strictEqual(res.body.limit, 1);
      assert.strictEqual(res.body.offset, 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('5. GET /api/admin/financial/stats GMV & Financial Overview', async () => {
    setupServices();
    const server = createTestServer(integrationService, { id: 'admin_1', role: 'ADMIN' });
    await new Promise(resolve => server.listen(0, resolve));

    try {
      await psm.topUpCustomerWallet({ customerId: 'CUST_STATS', amountPaise: 300000, idempotencyKey: 'TOP_S' });

      // Trip 1: Settled ₹500 (50,000 paise)
      // Commission: ₹50, GST: ₹9, Driver: ₹441
      await integrationService.reserveEscrow({ tripId: 'TRIP_STAT_1', customerId: 'CUST_STATS', amountPaise: 50000 });
      await integrationService.settleTrip({ tripId: 'TRIP_STAT_1', driverId: 'DRV_S1', amountPaise: 50000 });

      // Trip 2: Cancelled & Refunded ₹200 (20,000 paise)
      await integrationService.reserveEscrow({ tripId: 'TRIP_STAT_2', customerId: 'CUST_STATS', amountPaise: 20000 });
      await integrationService.refundTrip({ tripId: 'TRIP_STAT_2', amountPaise: 20000, reason: 'Passenger cancelled' });

      // Trip 3: Active in Escrow ₹100 (10,000 paise)
      await integrationService.reserveEscrow({ tripId: 'TRIP_STAT_3', customerId: 'CUST_STATS', amountPaise: 10000 });

      const res = await makeRequest(server, { method: 'GET', path: '/api/admin/financial/stats' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);

      const stats = res.body.stats;
      // GMV = 50000 + 20000 + 10000 = 80000 paise (₹800.00)
      assert.strictEqual(stats.gmv.paise, 80000);
      assert.strictEqual(stats.gmv.rupees, 800);

      // Active Escrow = 10000 paise (₹100.00)
      assert.strictEqual(stats.activeEscrow.paise, 10000);

      // Settled Earnings = 44100 paise (₹441.00)
      assert.strictEqual(stats.settledEarnings.paise, 44100);

      // Platform Commission = 5000 paise (₹50.00)
      assert.strictEqual(stats.platformCommission.paise, 5000);

      // Statutory GST = 900 paise (₹9.00)
      assert.strictEqual(stats.statutoryGst.paise, 900);

      // Refunded = 20000 paise (₹200.00)
      assert.strictEqual(stats.refunded.paise, 20000);

      // State counts
      assert.strictEqual(stats.totalTransactions, 3);
      assert.strictEqual(stats.byState.SETTLED, 1);
      assert.strictEqual(stats.byState.REFUNDED, 1);
      assert.strictEqual(stats.byState.ESCROWED, 1);
      assert.strictEqual(stats.byState.EXPIRED, 0);
      assert.strictEqual(stats.byState.DISPUTED, 0);
      assert.strictEqual(stats.byState.ADJUSTED, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
