'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateProductionReadiness, isTruthy } = require('../../src/services/productionReadinessService');

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

test('production readiness blocks every enabled provider with incomplete credentials', () => {
  const result = evaluateProductionReadiness({
    ...baseProductionEnv(),
    MAPS_PROVIDER_ENABLED: 'yes',
    SMS_PROVIDER_ENABLED: '1',
    EMAIL_PROVIDER_ENABLED: 'on',
    RAZORPAY_ENABLED: 'true'
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockingFailures.sort(), [
    'mapsProvider',
    'paymentsProvider',
    'smsProvider',
    'emailProvider'
  ].sort());
});

test('production readiness accepts fully configured enabled providers', () => {
  const result = evaluateProductionReadiness({
    ...baseProductionEnv(),
    MAPS_PROVIDER_ENABLED: 'true',
    MAPS_API_KEY: 'maps-secret',
    RAZORPAY_ENABLED: 'true',
    RAZORPAY_KEY_ID: 'rzp-id',
    RAZORPAY_KEY_SECRET: 'rzp-secret',
    RAZORPAY_WEBHOOK_SECRET: 'rzp-webhook',
    SMS_PROVIDER_ENABLED: 'true',
    SMS_PROVIDER_API_KEY: 'sms-secret',
    EMAIL_PROVIDER_ENABLED: 'true',
    EMAIL_PROVIDER_API_KEY: 'email-secret'
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockingFailures, []);
  assert.equal(result.providers.every((provider) => provider.ready && provider.credentialsConfigured), true);
});

test('production readiness rejects whitespace-only required secrets', () => {
  const result = evaluateProductionReadiness({
    ...baseProductionEnv(),
    JWT_SECRET: ' '.repeat(32),
    VAAYU_ADMIN_USERS_JSON: '   '
  });
  assert.equal(result.ready, false);
  assert.ok(result.blockingFailures.includes('jwtSecret'));
  assert.ok(result.blockingFailures.includes('adminConfiguration'));
});

test('production readiness requires an explicit Postgres URL even when the provider name says postgres', () => {
  const result = evaluateProductionReadiness({
    ...baseProductionEnv(),
    DATABASE_URL: 'mysql://vaayu:secret@db.example/vaayu',
    PERSISTENCE_PROVIDER: 'postgres'
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockingFailures, ['durableDatabase']);
});

test('provider truthiness is strict and deterministic', () => {
  assert.equal(isTruthy('TRUE'), true);
  assert.equal(isTruthy(' yes '), true);
  assert.equal(isTruthy('on'), true);
  assert.equal(isTruthy('false'), false);
  assert.equal(isTruthy('enabled'), false);
  assert.equal(isTruthy(''), false);
  assert.equal(isTruthy(undefined), false);
});

test('non-production environments can report incomplete deployment configuration without being launch blockers', () => {
  const result = evaluateProductionReadiness({ NODE_ENV: 'test' });
  assert.equal(result.environment, 'non-production');
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockingFailures, []);
});
