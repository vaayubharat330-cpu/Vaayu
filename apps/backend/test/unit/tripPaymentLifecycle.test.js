'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOrderRoutes } = require('../../src/http/orderRoutes');
const { createTripBookingRoutes } = require('../../src/http/tripBookingRoutes');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const { DELIVERY_STATES } = require('../../src/services/deliveryStateMachine');
const { parseJsonBody, validateFields } = require('../../src/http/helpers');
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

  // Mock DeliveryStateMachine that simulates Milestone 3 transitions
  const mockDeliveryStateMachine = {
    transition: async (orderId, targetState, actor, options = {}) => {
      let trip = mockDbStore.trips.find(t => t.id === orderId);
      if (!trip) {
        trip = { id: orderId, tripId: orderId, status: 'CREATED', totalFare: 500, driver: { id: 'drv_e2e' } };
        mockDbStore.trips.push(trip);
      }
      trip.status = targetState;
      return {
        success: true,
        orderId,
        currentState: targetState,
        version: 2
      };
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

test('VAAYU Phase D: Trip & Dispatch Lifecycle Payment Integration', async (t) => {

  await t.test('1. Trip Booking -> Escrow Hold -> Driver Completion -> Automatic Settle', async () => {
    const { dir, psm, ledger, mockDbStore, handleOrderRoute } = createE2EHarness();
    try {
      // 1. Customer has ₹1,000 in PSM wallet
      await psm.topUpCustomerWallet({ customerId: 'cust_e2e', amountPaise: 100000 });

      // 2. Customer creates booking with ₹500 fare -> reserves escrow
      const orderId = 'ORD_E2E_COMPLETE_1';
      await psm.reserveEscrow({
        tripId: orderId,
        customerId: 'cust_e2e',
        amountPaise: 50000,
        idempotencyKey: `VAAYU:${orderId}:ESCROW`
      });

      assert.equal(psm.getBalance('escrow:platform'), 50000);
      assert.equal(psm.getCustomerBalance('cust_e2e').paise, 50000);

      // Register trip in DB
      mockDbStore.trips.push({
        id: orderId,
        tripId: orderId,
        customerId: 'cust_e2e',
        status: 'IN_TRANSIT',
        totalFare: 500,
        driver: { id: 'drv_e2e' }
      });

      // 3. Driver completes trip (drop-off OTP verified via /api/orders/complete)
      const req = new EventEmitter();
      req.method = 'POST';
      req.url = '/api/orders/complete';
      req.user = { id: 'drv_e2e', role: 'DRIVER' };

      let resCode = 200;
      let resBody = '';
      const res = {
        writeHead(c) { resCode = c; },
        setHeader() {},
        end(chunk) { if (chunk) resBody += chunk; }
      };

      const routePromise = handleOrderRoute(req, res, { pathname: '/api/orders/complete', parsedUrl: {} });
      process.nextTick(() => {
        req.emit('data', JSON.stringify({ orderId, otp: '1234' }));
        req.emit('end');
      });

      await routePromise;
      await new Promise(r => setTimeout(r, 25));

      const parsedRes = JSON.parse(resBody);
      assert.equal(resCode, 200);
      assert.equal(parsedRes.success, true);
      assert.equal(parsedRes.paymentSettlement.success, true);
      assert.equal(parsedRes.paymentSettlement.state, 'SETTLED');
      assert.equal(parsedRes.paymentSettlement.driverEarningsPaise, 44100);
      assert.equal(parsedRes.paymentSettlement.commissionPaise, 5000);
      assert.equal(parsedRes.paymentSettlement.gstPaise, 900);

      // 4. Verify double-entry ledger state
      assert.equal(psm.getBalance('escrow:platform'), 0);
      assert.equal(psm.getDriverBalance('drv_e2e').paise, 44100);
      assert.equal(psm.getBalance('platform:commission'), 5000);
      assert.equal(psm.getBalance('platform:gst'), 900);

      const audit = ledger.reconcile();
      assert.equal(audit.ok, true);
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
        totalFare: 350
      });

      // Customer cancels order via /api/orders/cancel
      const req = new EventEmitter();
      req.method = 'POST';
      req.url = '/api/orders/cancel';
      req.user = { id: 'cust_e2e', role: 'CUSTOMER' };

      let resCode = 200;
      let resBody = '';
      const res = {
        writeHead(c) { resCode = c; },
        setHeader() {},
        end(chunk) { if (chunk) resBody += chunk; }
      };

      const routePromise = handleOrderRoute(req, res, { pathname: '/api/orders/cancel', parsedUrl: {} });
      process.nextTick(() => {
        req.emit('data', JSON.stringify({ orderId, reason: 'Customer changed plans' }));
        req.emit('end');
      });

      await routePromise;
      await new Promise(r => setTimeout(r, 25));

      const parsedRes = JSON.parse(resBody);
      assert.equal(resCode, 200);
      assert.equal(parsedRes.success, true);
      assert.equal(parsedRes.paymentRefund.success, true);
      assert.equal(parsedRes.paymentRefund.state, 'REFUNDED');
      assert.equal(parsedRes.paymentRefund.refundedPaise, 35000);

      // Verify customer wallet is 100% restored
      assert.equal(psm.getBalance('escrow:platform'), 0);
      assert.equal(psm.getCustomerBalance('cust_e2e').paise, 100000);

      const audit = ledger.reconcile();
      assert.equal(audit.ok, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
