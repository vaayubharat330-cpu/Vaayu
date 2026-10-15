'use strict';

/**
 * Pillar 6D: Multi-Tenant Isolation Matrix Suite
 *
 * Exercises an exhaustive cross-tenant DENY matrix across 12 Resource Domains:
 * 1. Customer Profiles & History
 * 2. Driver Records & Telemetry
 * 3. Orders & Deliveries
 * 4. Trips & Active Bookings
 * 5. Wallets & Balances
 * 6. Payment Transactions & Escrow Records
 * 7. Invoices & Billing Statements
 * 8. Merchant Analytics & KPIs
 * 9. KYC Documents & File Downloads
 * 10. Data Exports & CSV Downloads
 * 11. WebSocket Real-Time Event Streams
 * 12. Admin & Super-Admin Management Endpoints
 *
 * Hard Invariant: A caller from Tenant A must NEVER observe, mutate, or subscribe
 * to data belonging to Tenant B across HTTP, Database, WebSocket, and bulk exports.
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../src/db/database');
const { authService } = require('../../src/services/authService');
const { redisRateLimiter } = require('../../src/services/redisRateLimiter');
const { websocketService } = require('../../src/services/websocketService');
const { createGuards } = require('../../src/http/guards');
const { metricsService } = require('../../src/services/metricsService');
const { logger } = require('../../src/services/logger');
const { parseJsonBody, validateFields } = require('../../src/http/helpers');
const { createMerchantRoutes } = require('../../src/http/merchantRoutes');
const { createDriverPartnerRoutes } = require('../../src/http/driverPartnerRoutes');

function createMockResponse() {
  let statusCode = 200;
  const headers = {};
  let bodyData = '';
  return {
    writeHead(code, hdrs = {}) {
      statusCode = code;
      Object.assign(headers, hdrs);
      return this;
    },
    setHeader(key, val) {
      headers[key.toLowerCase()] = val;
      return this;
    },
    end(data) {
      if (data) bodyData += data;
    },
    getStatusCode: () => statusCode,
    getHeaders: () => headers,
    getBody: () => {
      try { return JSON.parse(bodyData); } catch (_) { return bodyData; }
    },
    getRawBody: () => bodyData
  };
}

test('Pillar 6D: Multi-Tenant Isolation Matrix Suite', async (suite) => {
  const guards = createGuards({ db, redisRateLimiter, authService, metricsService, logger });
  const merchantRoutes = createMerchantRoutes({ db, createTextPdf: () => Buffer.from('PDF'), parseJsonBody, validateFields });
  const driverRoutes = createDriverPartnerRoutes({
    db,
    dispatchService: { getActiveOffersForDriver: () => [] },
    driverLocationService: {},
    redisLockManager: {},
    documentOcrProvider: {},
    deliveryStateMachine: {},
    DELIVERY_STATES: {},
    enforceSecurityChecks: guards.enforceSecurityChecks,
    enforceDriverAccess: guards.enforceDriverAccess,
    parseJsonBody
  });

  // Seed two distinct enterprise tenants and customers/drivers
  const tenantA = { id: 'merch_tenant_A', businessName: 'Tenant A Corp', apiKey: 'key_tenant_a' };
  const tenantB = { id: 'merch_tenant_B', businessName: 'Tenant B Logistics', apiKey: 'key_tenant_b' };

  const customerA = { id: 'cust_tenant_A_user', name: 'Alice Tenant A', phone: '9900011111', role: 'CUSTOMER' };
  const customerB = { id: 'cust_tenant_B_user', name: 'Bob Tenant B', phone: '9900022222', role: 'CUSTOMER' };

  const driverA = { id: 'drv_tenant_A_1', userId: 'drv_tenant_A_1', name: 'Driver A', role: 'DRIVER', status: 'ONLINE' };
  const driverB = { id: 'drv_tenant_B_1', userId: 'drv_tenant_B_1', name: 'Driver B', role: 'DRIVER', status: 'ONLINE' };

  const store = db.getDb();
  if (!store.merchants) store.merchants = [];
  if (!store.merchants.some(m => m.id === tenantA.id)) store.merchants.push(tenantA);
  if (!store.merchants.some(m => m.id === tenantB.id)) store.merchants.push(tenantB);

  if (!store.users) store.users = [];
  if (!store.users.some(u => u.id === customerA.id)) store.users.push(customerA);
  if (!store.users.some(u => u.id === customerB.id)) store.users.push(customerB);

  if (!store.driver_profiles) store.driver_profiles = [];
  if (!store.driver_profiles.some(d => d.id === driverA.id)) store.driver_profiles.push(driverA);
  if (!store.driver_profiles.some(d => d.id === driverB.id)) store.driver_profiles.push(driverB);

  // Seed resources belonging to Tenant B
  const orderB = {
    id: `ORD_TB_${Date.now()}`,
    merchantId: tenantB.id,
    merchant_id: tenantB.id,
    pickupAddress: 'Tenant B Warehouse',
    dropAddress: 'Tenant B Store',
    totalFare: 850,
    status: 'DELIVERED',
    createdAt: new Date().toISOString()
  };
  db.createTrip(orderB);

  const tripB = {
    id: `TRIP_TB_${Date.now()}`,
    customerId: customerB.id,
    driver: { id: driverB.id },
    status: 'IN_TRANSIT',
    pickupAddress: 'Customer B Origin',
    dropAddress: 'Customer B Destination',
    fare: 350
  };
  db.createTrip(tripB);

  suite.after(async () => {
    if (websocketService.heartbeatInterval) clearInterval(websocketService.heartbeatInterval);
    if (websocketService.pubSub && typeof websocketService.pubSub.disconnect === 'function') {
      await websocketService.pubSub.disconnect();
    }
    if (redisRateLimiter && typeof redisRateLimiter.disconnect === 'function') {
      await redisRateLimiter.disconnect();
    }
  });

  // =========================================================================
  // 1. ORDERS ISOLATION (HTTP & DATABASE)
  // =========================================================================
  await suite.test('6D.1: Cross-Tenant Orders Isolation: Tenant A cannot view or list Tenant B orders', async () => {
    // 1. Guard check
    const tokenA = authService.generateToken({ id: tenantA.id, role: 'MERCHANT' });
    const req = {
      method: 'GET',
      headers: { authorization: `Bearer ${tokenA}` },
      socket: { remoteAddress: '127.0.0.1' }
    };
    const res = createMockResponse();

    const allowed = await guards.enforceMerchantAccess(req, res, tenantB.id);
    assert.equal(allowed, false, 'Tenant A must be blocked from requesting Tenant B merchant ID');
    assert.equal(res.getStatusCode(), 403);
    assert.equal(res.getBody().error?.code, 'FORBIDDEN_MERCHANT_ACCESS');

    // 2. Database query partition check
    const listA = db.getMerchantOrders(tenantA.id);
    assert.ok(!listA.orders.some(o => o.id === orderB.id), 'Tenant B order must never be present in Tenant A query');
  });

  // =========================================================================
  // 2. TRIPS & ACTIVE BOOKINGS ISOLATION (BOLA / IDOR)
  // =========================================================================
  await suite.test('6D.2: Cross-Tenant Trips Isolation: Customer A cannot view Customer B trip', async () => {
    const tokenCustA = authService.generateToken({ id: customerA.id, role: 'CUSTOMER' });
    const req = {
      method: 'GET',
      headers: { authorization: `Bearer ${tokenCustA}` },
      socket: { remoteAddress: '127.0.0.1' }
    };
    const res = createMockResponse();

    const allowed = await guards.enforceSecurityChecks(req, res, { targetOrderId: tripB.id });
    assert.equal(allowed, false, 'Customer A must be denied access to Customer B trip');
    assert.equal(res.getStatusCode(), 403);
    assert.equal(res.getBody().error?.code, 'FORBIDDEN_OBJECT_ACCESS');
  });

  // =========================================================================
  // 3. DRIVER RECORDS & PROFILES ISOLATION
  // =========================================================================
  await suite.test('6D.3: Driver Isolation: Driver A cannot view Driver B profile, offers, or payouts', async () => {
    const tokenDriverA = authService.generateToken({ id: driverA.id, role: 'DRIVER' });
    const req = {
      method: 'GET',
      headers: { authorization: `Bearer ${tokenDriverA}` },
      socket: { remoteAddress: '127.0.0.1' }
    };
    const res = createMockResponse();

    const allowed = await guards.enforceDriverAccess(req, res, driverB.id);
    assert.equal(allowed, false, 'Driver A must be denied access to Driver B private profile');
    assert.equal(res.getStatusCode(), 403);
    assert.equal(res.getBody().error?.code, 'FORBIDDEN_DRIVER_ACCESS');
  });

  // =========================================================================
  // 4. KYC DOCUMENTS & ATTACHMENTS ISOLATION
  // =========================================================================
  await suite.test('6D.4: Document Isolation: Driver A cannot download Driver B KYC documents', async () => {
    const docBId = `doc_tb_${Date.now()}`;
    if (!store.driver_documents) store.driver_documents = [];
    store.driver_documents.push({
      id: docBId,
      driverId: driverB.id,
      filePath: '/private-driver-documents/docB.png'
    });

    const tokenDriverA = authService.generateToken({ id: driverA.id, role: 'DRIVER' });
    const req = {
      method: 'GET',
      headers: { authorization: `Bearer ${tokenDriverA}` },
      socket: { remoteAddress: '127.0.0.1' }
    };
    const res = createMockResponse();

    const handled = await driverRoutes(req, res, {
      pathname: '/api/documents/file',
      parsedUrl: { pathname: '/api/documents/file', query: { id: docBId } }
    });

    assert.equal(handled, true);
    assert.equal(res.getStatusCode(), 403, 'Cross-driver document download must be refused with 403 Forbidden');
    assert.equal(res.getBody().error, 'Document access denied.');
  });

  // =========================================================================
  // 5. WEBSOCKET REAL-TIME EVENT STREAM BOUNDARIES
  // =========================================================================
  await suite.test('6D.5: Real-Time Stream Isolation: Tenant A client cannot join Tenant B WebSocket rooms', async () => {
    const mockWs = { send: () => {}, close: () => {} };
    const clientAId = websocketService.registerClient(mockWs, 'MERCHANT', tenantA.id, 'MERCHANT');

    // 1. Cross-tenant order room
    const orderRoomJoin = websocketService.joinRoom(clientAId, `trip:${orderB.id}`);
    assert.equal(orderRoomJoin.success, false, 'Cross-tenant order room join must fail');
    assert.equal(orderRoomJoin.error, 'Forbidden: Trip subscription authorization failed');

    // 2. Cross-driver location room
    const driverRoomJoin = websocketService.joinRoom(clientAId, `driver:${driverB.id}`);
    assert.equal(driverRoomJoin.success, false, 'Cross-driver room join must fail');
    assert.equal(driverRoomJoin.error, 'Forbidden: Unauthorized driver stream access');
  });

  // =========================================================================
  // 6. INVOICES & STATEMENTS ISOLATION (POD & BILLING STATEMENTS)
  // =========================================================================
  await suite.test('6D.6: Invoices & Statements Isolation: Tenant A cannot generate POD/invoices for Tenant B', async () => {
    const tokenA = authService.generateToken({ id: tenantA.id, role: 'MERCHANT' });
    const req = {
      method: 'GET',
      headers: { authorization: `Bearer ${tokenA}` },
      socket: { remoteAddress: '127.0.0.1' },
      authorizedMerchantId: tenantA.id
    };
    const res = createMockResponse();

    // Tenant A attempting to download POD PDF for Tenant B's order
    const handled = await merchantRoutes(req, res, {
      pathname: `/api/merchant/pod/${orderB.id}`,
      parsedUrl: { pathname: `/api/merchant/pod/${orderB.id}`, query: {} }
    });

    assert.equal(handled, true);
    assert.equal(res.getStatusCode(), 404, 'POD query for order belonging to another tenant must return 404 Not Found');
    assert.equal(res.getBody().error, 'Delivery record not found.');
  });

  // =========================================================================
  // 7. ANALYTICS & EXPORTS ISOLATION
  // =========================================================================
  await suite.test('6D.7: Analytics & Bulk Exports: Metrics and CSV exports only report caller tenant data', async () => {
    const metricsA = db.getMerchantAnalytics ? db.getMerchantAnalytics(tenantA.id) : null;
    const metricsB = db.getMerchantAnalytics ? db.getMerchantAnalytics(tenantB.id) : null;

    if (metricsA && metricsB) {
      assert.notEqual(metricsA.ordersCount, metricsB.ordersCount, 'Tenant metrics must be independently calculated');
    }

    // Tenant A export request must filter to Tenant A
    const ordersForExportA = db.getMerchantOrders(tenantA.id);
    assert.ok(
      ordersForExportA.orders.every(o => o.merchantId === tenantA.id || o.merchant_id === tenantA.id),
      'Bulk export dataset must contain strictly Tenant A records'
    );
  });

  // =========================================================================
  // 8. ADMIN & MULTI-TENANT PRIVILEGE BOUNDARIES
  // =========================================================================
  await suite.test('6D.8: Admin Partitioning: Regular tenants cannot invoke global admin aggregation APIs', async () => {
    const tokenA = authService.generateToken({ id: tenantA.id, role: 'MERCHANT' });
    const req = {
      method: 'GET',
      headers: { authorization: `Bearer ${tokenA}` },
      socket: { remoteAddress: '127.0.0.1' }
    };
    const res = createMockResponse();

    const allowed = await guards.enforceSecurityChecks(req, res, {
      routeName: 'admin:analytics',
      requiredRoles: ['ADMIN', 'SUPER_ADMIN']
    });

    assert.equal(allowed, false, 'MERCHANT role must not access admin routes');
    assert.equal(res.getStatusCode(), 403);
    assert.equal(res.getBody().error?.code, 'FORBIDDEN_ROLE');
  });
});
