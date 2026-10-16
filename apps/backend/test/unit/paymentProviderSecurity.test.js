'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { PaymentProvider } = require('../../src/services/paymentProvider');

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('Razorpay remote operations fail closed unless explicitly enabled', async () => {
  const provider = new PaymentProvider({ fetchImpl: async () => { throw new Error('network should not be reached'); } });
  await withEnv({ RAZORPAY_KEY_ID: 'key', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_ENABLED: 'false' }, async () => {
    await assert.rejects(() => provider.createOrder({ amount: 100, receipt: 'test_receipt' }), /live operations are disabled/i);
  });
});

test('Razorpay signature verification rejects malformed hex before comparison', async () => {
  const provider = new PaymentProvider();
  await withEnv({ RAZORPAY_KEY_SECRET: 'secret' }, async () => {
    const orderId = 'order_123';
    const paymentId = 'pay_123';
    const signature = crypto.createHmac('sha256', 'secret').update(`${orderId}|${paymentId}`).digest('hex');
    assert.equal(provider.verifySignature(orderId, paymentId, signature), true);
    assert.equal(provider.verifySignature(orderId, paymentId, 'zz'.repeat(32)), false);
    assert.equal(provider.verifySignature(orderId, paymentId, signature.slice(0, -2)), false);
  });
});

test('Razorpay order creation rejects non-INR currency before network call', async () => {
  const provider = new PaymentProvider({ fetchImpl: async () => { throw new Error('network should not be reached'); } });
  await withEnv({ RAZORPAY_KEY_ID: 'key', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_ENABLED: 'true' }, async () => {
    await assert.rejects(() => provider.createOrder({ amount: 100, currency: 'USD', receipt: 'test_receipt' }), /INR only/i);
  });
});

test('Razorpay payout requires an idempotency key', async () => {
  const provider = new PaymentProvider({ fetchImpl: async () => { throw new Error('network should not be reached'); } });
  await withEnv({
    RAZORPAY_KEY_ID: 'key',
    RAZORPAY_KEY_SECRET: 'secret',
    RAZORPAY_ENABLED: 'true',
    VAAYU_ENABLE_RAZORPAYX_PAYOUTS: 'true',
    RAZORPAYX_ACCOUNT_NUMBER: 'acc'
  }, async () => {
    await assert.rejects(() => provider.createUpiPayout({ amount: 100, upiId: 'driver@example', name: 'Driver', phone: '9876543210', referenceId: 'ref' }), /idempotency key is required/i);
  });
});
