'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');

function makeService() {
  const calls = [];
  const ledger = {
    async expirePayment(args) { calls.push(['expirePayment', args]); return { paymentId: 'PAY_T1', tripId: 'T1', status: 'EXPIRED', releasedPaise: 5000, idempotentReplay: false, version: 3 }; },
    async disputePayment(args) { calls.push(['disputePayment', args]); return { paymentId: 'PAY_T1', tripId: 'T1', disputeId: args.disputeId, status: 'DISPUTED', idempotentReplay: false, version: 4 }; },
    async adjustPayment(args) { calls.push(['adjustPayment', args]); return { paymentId: 'PAY_T1', tripId: 'T1', disputeId: args.disputeId, status: 'ADJUSTED', adjustmentPaise: args.adjustmentPaise, allocations: args.allocations, idempotentReplay: false, version: 5 }; }
  };
  const psm = {
    ledger,
    on() {},
    async expirePayment() { throw new Error('PSM fallback must not be used'); },
    async disputePayment() { throw new Error('PSM fallback must not be used'); },
    async adjustPayment() { throw new Error('PSM fallback must not be used'); }
  };
  return { service: new PaymentIntegrationService({ paymentStateMachine: psm }), calls };
}

test('durable payment lifecycle actions route to the ledger when available', async () => {
  const { service, calls } = makeService();

  const expired = await service.expirePayment({ tripId: 'T1' });
  assert.equal(expired.success, true);
  assert.equal(expired.state, 'EXPIRED');

  const disputed = await service.disputePayment({ tripId: 'T1', disputeId: 'D1' });
  assert.equal(disputed.success, true);
  assert.equal(disputed.state, 'DISPUTED');

  const adjusted = await service.adjustPayment({ tripId: 'T1', disputeId: 'D1', adjustmentPaise: 1000, allocations: { customer: 1000 } });
  assert.equal(adjusted.success, true);
  assert.equal(adjusted.state, 'ADJUSTED');

  assert.deepEqual(calls.map(([name]) => name), ['expirePayment', 'disputePayment', 'adjustPayment']);
});
