'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOrderRoutes } = require('../../src/http/orderRoutes');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const { DELIVERY_STATES } = require('../../src/services/deliveryStateMachine');
const { parseJsonBody } = require('../../src/http/helpers');
const { EventEmitter } = require('events');

function createE2EHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-lifecycle-test-'));
  const repo = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository: repo });
  const psm = new PaymentStateMachine({ ledgerService: ledger, commissionConfig: { commissionBps: 1000, gstBps: 1800 } });
  const paymentIntegrationService = new PaymentIntegrationService({ paymentStateMachine: psm });

  const mockDbStore = {
    trips: [],
    users: [{ id: 'cust_e2e', name: 'E2E Customer', walletBalance: 1000 }]
  };

  const mockDb = {
    getDb: () => mockDbStore,
    getTripById: (id) => mockDbStore.trips.find(t => t.id === id),
    debitCustomerWallet: (cid, amt) => ({ success: true }),
    getDrivers: () => [{ id: 'drv_e2e', userId: 'usr_drv_e2e' }],
    recordDriverTripCompletion: () => true
  };

  const mockDeliveryStateMachine = {
    transition: async (orderId, targetState, actor, options = {}) => {
      let trip = mockDbStore.trips.find(t => t.id === orderId);
      if (!trip) {
        trip = { id: orderId, tripId: orderId, status: 'CREATED', totalFare: 500, driver: { id: 'drv_e2e' } };
        mockDbStore.trips.push(trip);
      }
      trip.status = targetState;
      return { success: true, orderId, currentState: targetState, version: 2 };
    }
  };

  const handleOrderRoute = createOrderRoutes({
    db: mockDb,
    deliveryStateMachine: mockDeliveryStateMachine,
    redisLockManager: { getDriverLock: async () => null, releaseDriverLock: async () => true },
    otpService: { markTripOtpVerified: () => true },
    paymentProvider: { refundPayment: async () => ({ success: true, refundIssued: true }) },
    idempotencyService: { findExistingResponse: async () => ({ found: false }), saveResponse: async () => true },
    dispatchService: { handleDriverAccept: async () => true },
    driverLocationService: { setDriverAvailability: async () => true },
    DELIVERY_STATES,
    enforceSecurityChecks: async (req, res) => true,
    parseJsonBody,
    paymentIntegrationService
  });

  return { dir, ledger, psm, paymentIntegrationService, mockDb, mockDbStore, handleOrderRoute };
}

function makePostRequest(handleOrderRoute, pathname, user, payload) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = pathname;
  req.user = user;

  let resCode = 200;
  let resBody = '';
  const res = {
    writeHead(c) { resCode = c; },
    setHeader() {},
    end(chunk) { if (chunk) resBody += chunk; }
  };

  const routePromise = handleOrderRoute(req, res, { pathname, parsedUrl: {} });
  process.nextTick(() => {
    req.emit('data', JSON.stringify(payload));
    req.emit('end');
  });

  return routePromise.then(async () => {
    await new Promise(r => setTimeout(r, 25));
    return { resCode, body: JSON.parse(resBody) };
  });
}

test('VAAYU Phase D: Trip & Dispatch Lifecycle Payment Integration', async (t) => {
  await t.test('1. Trip Booking -> Escrow Hold -> Driver Completion -> Automatic Settle', async () => {
    const { dir, psm, ledger, mockDbStore, handleOrderRoute } = createE2EHarness();
    try {
      await psm.topUpCustomerWallet({ customerId: 'cust_e2e', amountPaise: 100000 });

      const orderId = 'ORD_E2E_COMPLETE_1';
      await psm.reserveEscrow({
        tripId: orderId,
        customerId: 'cust_e2e',
        amountPaise: 50000,
        idempotencyKey: `VAAYU:${orderId}:ESCROW`
      });

      assert.equal(psm.getBalance('escrow:platform'), 50000);
      assert.equal(psm.getCustomerBalance('cust_e2e').paise, 50000);

      mockDbStore.trips.push({
        id: orderId,
        tripId: orderId,
        customerId: 'cust_e2e',
        status: 'IN_TRANSIT',
        totalFare: 500,
        driver: { id: 'drv_e2e' },
        paymentInfo: { paymentMethod: 'WALLET', provider: 'VAAYU_WALLET' }
      });

      const { resCode, body: parsedRes } = await makePostRequest(
        handleOrderRoute,
        '/api/orders/complete',
        { id: 'drv_e2e', role: 'DRIVER' },
        { orderId, otp: '1234' }
      );

      assert.equal(resCode, 200);
      assert.equal(parsedRes.success, true);
      assert.equal(parsedRes.paymentSettlement.success, true);
      assert.equal(parsedRes.paymentSettlement.state, 'SETTLED');
      assert.equal(parsedRes.paymentSettlement.driverEarningsPaise, 44100);
      assert.equal(parsedRes.paymentSettlement.commissionPaise, 5000);
      assert.equal(parsedRes.paymentSettlement.gstPaise, 900);

      assert.equal(psm.getBalance('escrow:platform'), 0);
      assert.equal(psm.getDriverBalance('drv_e2e').paise, 44100);
      assert.equal(psm.getBalance('platform:commission'), 5000);
      assert.equal(psm.getBalance('platform:gst'), 900);
      assert.equal(ledger.reconcile().ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('2. Trip Booking -> Escrow Hold -> Cancellation -> Automatic Refund', async () => {
    const { dir, psm, ledger, mockDbStore, handleOrderRoute } = createE2EHarness();
    try {
      await psm.topUpCustomerWallet({ customerId: 'cust_e2e', amountPaise: 100000 });

      const orderId = 'ORD_E2E_CANCEL_1';
      await psm.reserveEscrow({
        tripId: orderId,
        customerId: 'cust_e2e',
        amountPaise: 35000,
        idempotencyKey: `VAAYU:${orderId}:ESCROW`
      });

      assert.equal(psm.getBalance('escrow:platform'), 35000);
      assert.equal(psm.getCustomerBalance('cust_e2e').paise, 65000);

      mockDbStore.trips.push({
        id: orderId,
        tripId: orderId,
        customerId: 'cust_e2e',
        status: 'SEARCHING_DRIVER',
        totalFare: 350,
        paymentInfo: { paymentMethod: 'WALLET', provider: 'VAAYU_WALLET' }
      });

      const { resCode, body: parsedRes } = await makePostRequest(
        handleOrderRoute,
        '/api/orders/cancel',
        { id: 'cust_e2e', role: 'CUSTOMER' },
        { orderId, reason: 'Customer changed plans' }
      );

      assert.equal(resCode, 200);
      assert.equal(parsedRes.success, true);
      assert.equal(parsedRes.paymentRefund.success, true);
      assert.equal(parsedRes.paymentRefund.state, 'REFUNDED');
      assert.equal(parsedRes.paymentRefund.refundedPaise, 35000);
      assert.equal(psm.getBalance('escrow:platform'), 0);
      assert.equal(psm.getCustomerBalance('cust_e2e').paise, 100000);
      assert.equal(ledger.reconcile().ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('3. Cash booking completion does not invoke the wallet ledger', async () => {
    const { dir, psm, mockDbStore, handleOrderRoute } = createE2EHarness();
    try {
      const orderId = 'ORD_E2E_CASH_COMPLETE_1';
      mockDbStore.trips.push({
        id: orderId,
        tripId: orderId,
        customerId: 'cust_e2e',
        status: 'IN_TRANSIT',
        totalFare: 500,
        driver: { id: 'drv_e2e' },
        paymentInfo: { paymentMethod: 'CASH_ON_DELIVERY' }
      });

      const { resCode, body } = await makePostRequest(
        handleOrderRoute,
        '/api/orders/complete',
        { id: 'drv_e2e', role: 'DRIVER' },
        { orderId, otp: '1234' }
      );

      assert.equal(resCode, 200);
      assert.equal(body.success, true);
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'paymentSettlement'), false);
      assert.equal(psm.getBalance('escrow:platform'), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('4. Cash booking cancellation does not invoke the wallet ledger or provider refund', async () => {
    const { dir, psm, mockDbStore, handleOrderRoute } = createE2EHarness();
    try {
      const orderId = 'ORD_E2E_CASH_CANCEL_1';
      mockDbStore.trips.push({
        id: orderId,
        tripId: orderId,
        customerId: 'cust_e2e',
        status: 'SEARCHING_DRIVER',
        totalFare: 350,
        paymentInfo: { paymentMethod: 'CASH_ON_DELIVERY' }
      });

      const { resCode, body } = await makePostRequest(
        handleOrderRoute,
        '/api/orders/cancel',
        { id: 'cust_e2e', role: 'CUSTOMER' },
        { orderId, reason: 'Cash order cancelled' }
      );

      assert.equal(resCode, 200);
      assert.equal(body.success, true);
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'paymentRefund'), false);
      assert.equal(body.refundInfo.status, 'NOT_APPLICABLE');
      assert.equal(psm.getBalance('escrow:platform'), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
