'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');

test('payment status prefers durable ledger after process restart', async () => {
  const durablePayment = {
    paymentId: 'PAY_TRIP_STATUS_1',
    tripId: 'TRIP_STATUS_1',
    customerId: 'CUS_1',
    amountPaise: 125000,
    escrowPaise: 0,
    refundedPaise: 0,
    state: 'SETTLED',
    version: 3,
    transactionId: 'JE-0000000042'
  };

  const service = new PaymentIntegrationService({
    ledgerService: {
      async getPaymentByTripId(tripId) {
        assert.equal(tripId, 'TRIP_STATUS_1');
        return durablePayment;
      }
    },
    paymentStateMachine: {
      on() {},
      getPaymentByTripId() {
        throw new Error('local PSM must not be consulted when durable status exists');
      }
    }
  });

  const result = await service.getPaymentStatus('TRIP_STATUS_1');
  assert.equal(result.success, true);
  assert.equal(result.source, 'durable-ledger');
  assert.equal(result.payment.paymentId, durablePayment.paymentId);
  assert.equal(result.payment.state, 'SETTLED');
});

test('payment status returns not found when durable ledger has no payment', async () => {
  const service = new PaymentIntegrationService({
    ledgerService: { async getPaymentByTripId() { return null; } },
    paymentStateMachine: { on() {}, getPaymentByTripId() { throw new Error('local fallback must not mask durable absence'); } }
  });

  const result = await service.getPaymentStatus('TRIP_MISSING');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'PAYMENT_NOT_FOUND');
});
