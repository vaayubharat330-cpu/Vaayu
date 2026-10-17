'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateProductionReadiness } = require('../../src/services/productionReadinessService');

const baseProductionEnv = () => ({
  NODE_ENV: 'production',
  PERSISTENCE_PROVIDER: 'postgres',
  DATABASE_URL: 'postgresql://vaayu:secret@db.example/vaayu',
  JWT_SECRET: '01234567890123456789012345678901',
  VAAYU_ADMIN_USERS_JSON: '[]'
});

test('production readiness accepts deferred external providers when explicitly disabled', () => {
  const result = evaluateProductionReadiness(baseProductionEnv());
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockingFailures, []);
  assert.equal(result.providers.every((provider) => provider.ready), true);
});

test('production readiness blocks an enabled provider with missing credentials', () => {
  const env = { ...baseProductionEnv(), RAZORPAY_ENABLED: 'true' };
  const result = evaluateProductionReadiness(env);
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockingFailures, ['paymentsProvider']);
  assert.deepEqual(result.providers.find((provider) => provider.name === 'payments').missing, [
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET'
  ]);
});

test('production readiness blocks missing durable infrastructure', () => {
  const env = { ...baseProductionEnv(), DATABASE_URL: 'sqlite://local' };
  const result = evaluateProductionReadiness(env);
  assert.equal(result.ready, false);
  assert.ok(result.blockingFailures.includes('durableDatabase'));
});

test('non-production environments can report incomplete deployment configuration without being launch blockers', () => {
  const result = evaluateProductionReadiness({ NODE_ENV: 'test' });
  assert.equal(result.environment, 'non-production');
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockingFailures, []);
});
