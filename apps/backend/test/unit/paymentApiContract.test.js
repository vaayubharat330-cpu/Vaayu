'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createPaymentRoutes } = require('../../src/http/paymentRoutes');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const { parseJsonBody, validateFields } = require('../../src/http/helpers');

function createTestHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-api-contract-test-'));
  const repo = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository: repo });
  const psm = new PaymentStateMachine({ ledgerService: ledger, commissionConfig: { commissionBps: 1000, gstBps: 1800 } });
  const integrationService = new PaymentIntegrationService({ paymentStateMachine: psm });

  const mockSecurityChecks = async (req, res, options = {}) => {
    const requiredRoles = options.requiredRoles;
    if (requiredRoles && req.user) {
      if (!requiredRoles.includes(req.user.role)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN_ROLE', message: 'Forbidden' } }));
        return false;
      }
    }
    return true;
  };

  const handleRoute = createPaymentRoutes({
    db: {},
    paymentProvider: { configured: false },
    paymentIntegrationService: integrationService,
    enforceSecurityChecks: mockSecurityChecks,
    parseJsonBody,
    validateFields
  });

  async function dispatch({ method, pathname, body, headers = {}, user = { id: 'c_api_1', role: 'CUSTOMER' } }) {
    const req = new EventEmitter();
    req.method = method;
    req.url = pathname;
    req.headers = { ...headers };
    req.user = user;

    let resCode = 200;
    const resHeaders = {};
    let resBody = '';

    const res = {
      writeHead(code, h = {}) {
        resCode = code;
        Object.assign(resHeaders, h);
      },
      setHeader(k, v) {
        resHeaders[k.toLowerCase()] = v;
      },
      end(chunk) {
        if (chunk) resBody += chunk;
      }
    };

    const routeHandledPromise = handleRoute(req, res, { pathname, parsedUrl: { query: {} } });

    // Stream body
    process.nextTick(() => {
      if (body !== undefined && body !== null) {
        req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.emit('end');
    });

    await routeHandledPromise;
    // Allow macro-task cycle for completion
    await new Promise(r => setTimeout(r, 25));

    let json = null;
    try {
      json = JSON.parse(resBody);
    } catch (_) {
      json = resBody;
    }

    return {
      status: resCode,
      headers: resHeaders,
      body: json
    };
  }

  return { dir, ledger, psm, integrationService, dispatch };
}

test('VAAYU Payment Phase C: API Contract Test Suite', async (t) => {

  await t.test('1. POST /api/payments/escrow Contract Tests', async () => {
    const { psm, dispatch, dir } = createTestHarness();
    try {
      // Setup customer balance
      await psm.topUpCustomerWallet({ customerId: 'c_api_1', amountPaise: 100000 });

      // A. Valid Escrow -> 201 Created
      const r1 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/escrow',
        headers: { 'idempotency-key': 'KEY_ESCROW_1' },
        body: {
          tripId: 'TRIP_API_1',
          amountPaise: 50000
        }
      });
      assert.equal(r1.status, 201);
      assert.equal(r1.body.success, true);
      assert.equal(r1.body.state, 'ESCROWED');
      assert.equal(r1.body.escrowPaise, 50000);

      // B. Duplicate Idempotency-Key -> 200 OK (Idempotent Replay)
      const r2 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/escrow',
        headers: { 'idempotency-key': 'KEY_ESCROW_1' },
        body: {
          tripId: 'TRIP_API_1',
          amountPaise: 50000
        }
      });
      assert.equal(r2.status, 200);
      assert.equal(r2.body.success, true);
      assert.equal(r2.body.idempotentReplay, true);

      // C. Same Key + Different Payload -> 409 Conflict
      const r3 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/escrow',
        headers: { 'idempotency-key': 'KEY_ESCROW_1' },
        body: {
          tripId: 'TRIP_API_1',
          amountPaise: 20000 // Altered amount with same key!
        }
      });
      assert.equal(r3.status, 409);
      assert.equal(r3.body.success, false);
      assert.equal(r3.body.error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

      // D. Insufficient Balance -> 400 Bad Request
      const r4 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/escrow',
        headers: { 'idempotency-key': 'KEY_ESCROW_OVER' },
        body: {
          tripId: 'TRIP_API_OVER',
          amountPaise: 900000 // Needs ₹9,000, wallet only has ₹500
        }
      });
      assert.equal(r4.status, 400);
      assert.equal(r4.body.success, false);
      assert.equal(r4.body.error.code, 'INSUFFICIENT_WALLET_BALANCE');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('2. POST /api/payments/settle Contract Tests', async () => {
    const { psm, dispatch, dir } = createTestHarness();
    try {
      await psm.topUpCustomerWallet({ customerId: 'c_api_1', amountPaise: 100000 });
      await psm.reserveEscrow({ tripId: 'TRIP_SETTLE_API', customerId: 'c_api_1', amountPaise: 50000 });

      // A. Valid Settle -> 200 OK
      const r1 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/settle',
        user: { id: 'admin_1', role: 'ADMIN' },
        headers: { 'idempotency-key': 'KEY_SETTLE_1' },
        body: {
          tripId: 'TRIP_SETTLE_API',
          driverId: 'd_api_1',
          amountPaise: 50000
        }
      });
      assert.equal(r1.status, 200);
      assert.equal(r1.body.success, true);
      assert.equal(r1.body.state, 'SETTLED');
      assert.equal(r1.body.totalFarePaise, 50000);
      assert.equal(r1.body.driverEarningsPaise, 44100);
      assert.equal(r1.body.commissionPaise, 5000);
      assert.equal(r1.body.gstPaise, 900);

      // B. Duplicate Settle -> 200 OK with idempotentReplay
      const r2 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/settle',
        user: { id: 'admin_1', role: 'ADMIN' },
        headers: { 'idempotency-key': 'KEY_SETTLE_1' },
        body: {
          tripId: 'TRIP_SETTLE_API',
          driverId: 'd_api_1',
          amountPaise: 50000
        }
      });
      assert.equal(r2.status, 200);
      assert.equal(r2.body.idempotentReplay, true);

      // C. Settle Non-existent Trip -> 404 Not Found
      const r3 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/settle',
        user: { id: 'admin_1', role: 'ADMIN' },
        body: {
          tripId: 'TRIP_GHOST',
          driverId: 'd_api_1'
        }
      });
      assert.equal(r3.status, 404);
      assert.equal(r3.body.error.code, 'PAYMENT_NOT_FOUND');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('3. POST /api/payments/refund Contract Tests', async () => {
    const { psm, dispatch, dir } = createTestHarness();
    try {
      await psm.topUpCustomerWallet({ customerId: 'c_api_1', amountPaise: 100000 });
      await psm.reserveEscrow({ tripId: 'TRIP_REF_API', customerId: 'c_api_1', amountPaise: 50000 });

      // A. Partial Refund -> 200 OK (state remains ESCROWED)
      const r1 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/refund',
        headers: { 'idempotency-key': 'KEY_REF_PARTIAL' },
        body: {
          tripId: 'TRIP_REF_API',
          amountPaise: 10000,
          reason: 'Discount adjustment'
        }
      });
      assert.equal(r1.status, 200);
      assert.equal(r1.body.state, 'ESCROWED');
      assert.equal(r1.body.isPartial, true);
      assert.equal(r1.body.refundedPaise, 10000);
      assert.equal(r1.body.remainingEscrowPaise, 40000);

      // B. Excessive Refund -> 422 Unprocessable Entity
      const r2 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/refund',
        headers: { 'idempotency-key': 'KEY_REF_OVER' },
        body: {
          tripId: 'TRIP_REF_API',
          amountPaise: 45000 // Escrow only has 40,000 remaining!
        }
      });
      assert.equal(r2.status, 422);
      assert.equal(r2.body.error.code, 'REFUND_LIMIT_EXCEEDED');

      // C. Full Refund of remaining escrow -> 200 OK (transitions to REFUNDED)
      const r3 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/refund',
        headers: { 'idempotency-key': 'KEY_REF_FULL' },
        body: {
          tripId: 'TRIP_REF_API',
          amountPaise: 40000
        }
      });
      assert.equal(r3.status, 200);
      assert.equal(r3.body.state, 'REFUNDED');
      assert.equal(r3.body.isPartial, false);
      assert.equal(r3.body.remainingEscrowPaise, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('4. POST /api/payments/expire Contract Tests', async () => {
    const { psm, dispatch, dir } = createTestHarness();
    try {
      await psm.topUpCustomerWallet({ customerId: 'c_api_1', amountPaise: 60000 });
      await psm.reserveEscrow({ tripId: 'TRIP_EXP_API', customerId: 'c_api_1', amountPaise: 40000 });

      // A. Valid Expire (internal worker) -> 200 OK
      const r1 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/expire',
        headers: {
          'x-internal-service': 'dispatch-worker',
          'idempotency-key': 'KEY_EXP_1'
        },
        body: {
          tripId: 'TRIP_EXP_API',
          reason: 'Dispatch timeout'
        }
      });
      assert.equal(r1.status, 200);
      assert.equal(r1.body.state, 'EXPIRED');
      assert.equal(r1.body.releasedPaise, 40000);

      // B. Repeated Expire -> 200 OK (idempotent replay, 0 released)
      const r2 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/expire',
        headers: {
          'x-internal-service': 'dispatch-worker',
          'idempotency-key': 'KEY_EXP_1'
        },
        body: {
          tripId: 'TRIP_EXP_API'
        }
      });
      assert.equal(r2.status, 200);
      assert.equal(r2.body.idempotentReplay, true);
      assert.equal(r2.body.releasedPaise, 0);

      // C. Expire on Settled Trip -> 409 Conflict
      await psm.reserveEscrow({ tripId: 'TRIP_SETTLE_NO_EXP', customerId: 'c_api_1', amountPaise: 20000 });
      await psm.settleTrip({ tripId: 'TRIP_SETTLE_NO_EXP', driverId: 'd_1', amountPaise: 20000 });

      const r3 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/expire',
        headers: { 'x-internal-service': 'dispatch-worker' },
        body: {
          tripId: 'TRIP_SETTLE_NO_EXP'
        }
      });
      assert.equal(r3.status, 409);
      assert.equal(r3.body.error.code, 'ILLEGAL_STATE_TRANSITION');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('5. POST /api/payments/dispute & /adjust Contract Tests', async () => {
    const { psm, dispatch, dir } = createTestHarness();
    try {
      await psm.topUpCustomerWallet({ customerId: 'c_api_1', amountPaise: 80000 });
      await psm.reserveEscrow({ tripId: 'TRIP_DISP_API', customerId: 'c_api_1', amountPaise: 50000 });
      await psm.settleTrip({ tripId: 'TRIP_DISP_API', driverId: 'd_api_1', amountPaise: 50000 });

      // Dispute -> 200 OK
      const r1 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/dispute',
        headers: { 'idempotency-key': 'KEY_DISP_1' },
        body: {
          tripId: 'TRIP_DISP_API',
          disputeId: 'DISP_101',
          reason: 'Damaged item reported'
        }
      });
      assert.equal(r1.status, 200);
      assert.equal(r1.body.state, 'DISPUTED');

      // Adjust -> 200 OK
      const r2 = await dispatch({
        method: 'POST',
        pathname: '/api/payments/adjust',
        user: { id: 'admin_1', role: 'ADMIN' },
        headers: { 'idempotency-key': 'KEY_ADJ_1' },
        body: {
          tripId: 'TRIP_DISP_API',
          disputeId: 'DISP_101',
          adjustmentPaise: 10000,
          allocations: {
            customerCreditPaise: 10000,
            driverDebitPaise: 8000,
            platformDebitPaise: 1695,
            taxAdjustmentPaise: 305
          }
        }
      });
      assert.equal(r2.status, 200);
      assert.equal(r2.body.state, 'ADJUSTED');
      assert.equal(r2.body.adjustmentPaise, 10000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
