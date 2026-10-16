'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOrderRoutes } = require('../../src/http/orderRoutes');
const { DELIVERY_STATES } = require('../../src/services/deliveryStates');
const { parseJsonBody } = require('../../src/http/helpers');

function makeRequest(payload) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/api/orders/complete';
  req.headers = {};
  req.user = { id: 'driver-1', role: 'DRIVER' };
  process.nextTick(() => {
    req.emit('data', JSON.stringify(payload));
    req.emit('end');
  });
  return req;
}

function makeResponse() {
  let statusCode = null;
  let body = '';
  return {
    get statusCode() { return statusCode; },
    get body() { return body; },
    writeHead(code) { statusCode = code; },
    end(chunk) { if (chunk) body += chunk; },
    get writableEnded() { return statusCode !== null; }
  };
}

test('order lifecycle releases idempotency lease when an unexpected command error occurs', async () => {
  const calls = { abort: [], transition: 0 };
  const handleOrderRoute = createOrderRoutes({
    db: { getTripById: () => ({ id: 'ORDER-1', paymentInfo: { paymentMethod: 'COD' } }) },
    deliveryStateMachine: {
      transition: async () => {
        calls.transition += 1;
        throw new Error('simulated transition failure');
      },
      getAuditLogs: () => []
    },
    redisLockManager: { getDriverLock: async () => null, releaseDriverLock: async () => true },
    otpService: { markTripOtpVerified: () => true },
    paymentProvider: { refundPayment: async () => ({ success: true }) },
    idempotencyService: {
      findExistingResponse: async () => ({ found: false }),
      abortResponse: async key => { calls.abort.push(key); return true; },
      saveResponse: async () => true
    },
    dispatchService: {},
    driverLocationService: {},
    DELIVERY_STATES,
    enforceSecurityChecks: async () => true,
    parseJsonBody,
    paymentIntegrationService: { settleTrip: async () => ({ success: true }), refundTrip: async () => ({ success: true }) }
  });

  const req = makeRequest({ orderId: 'ORDER-1', idempotencyKey: 'ORDER-1-COMPLETE-1' });
  const res = makeResponse();
  const handled = await handleOrderRoute(req, res, { pathname: '/api/orders/complete', parsedUrl: {} });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(handled, true);
  assert.equal(calls.transition, 1);
  assert.deepEqual(calls.abort, ['ORDER-1-COMPLETE-1']);
  assert.equal(res.statusCode, 500);
  const response = JSON.parse(res.body);
  assert.equal(response.success, false);
  assert.equal(response.error.code, 'INTERNAL_COMMAND_ERROR');
});
