'use strict';

/**
 * Evaluates whether the deployment is ready for a real commercial launch.
 *
 * This deliberately distinguishes engineering readiness from external-provider
 * readiness. A provider may be disabled during development, but production
 * launch must explicitly acknowledge every missing live dependency.
 */
const PROVIDER_ENV = Object.freeze({
  maps: ['MAPS_PROVIDER_ENABLED', 'MAPS_API_KEY'],
  payments: ['RAZORPAY_ENABLED', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
  sms: ['SMS_PROVIDER_ENABLED', 'SMS_PROVIDER_API_KEY'],
  email: ['EMAIL_PROVIDER_ENABLED', 'EMAIL_PROVIDER_API_KEY']
});

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function hasValue(env, key) {
  return typeof env[key] === 'string' && env[key].trim().length > 0;
}

function evaluateProvider(env, name, keys) {
  const enabled = isTruthy(env[keys[0]]);
  const credentials = keys.slice(1).every((key) => hasValue(env, key));
  return {
    name,
    enabled,
    credentialsConfigured: credentials,
    ready: !enabled || credentials,
    missing: enabled ? keys.slice(1).filter((key) => !hasValue(env, key)) : []
  };
}

function evaluateProductionReadiness(env = process.env) {
  const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const durableDatabase = String(env.PERSISTENCE_PROVIDER || '').toLowerCase() === 'postgres'
    && /^postgres(?:ql)?:\/\//.test(String(env.DATABASE_URL || ''));
  const jwtReady = hasValue(env, 'JWT_SECRET') && env.JWT_SECRET.length >= 32;
  const adminReady = hasValue(env, 'VAAYU_ADMIN_USERS_JSON');
  const providers = Object.entries(PROVIDER_ENV).map(([name, keys]) => evaluateProvider(env, name, keys));

  const checks = [
    { name: 'durableDatabase', ready: durableDatabase, requiredInProduction: true },
    { name: 'jwtSecret', ready: jwtReady, requiredInProduction: true },
    { name: 'adminConfiguration', ready: adminReady, requiredInProduction: true },
    ...providers.map((provider) => ({
      name: `${provider.name}Provider`,
      ready: provider.ready,
      requiredInProduction: provider.enabled
    }))
  ];

  // Deployment configuration is intentionally non-blocking outside production.
  // The checks still expose what is incomplete so CI/development tooling can
  // report configuration gaps without falsely declaring a test environment
  // unready for commercial launch.
  const blocking = production
    ? checks.filter((check) => !check.ready && (check.requiredInProduction || check.name.endsWith('Provider')))
    : [];

  return {
    environment: production ? 'production' : 'non-production',
    ready: blocking.length === 0,
    checks,
    providers,
    blockingFailures: blocking.map((check) => check.name)
  };
}

module.exports = {
  PROVIDER_ENV,
  evaluateProductionReadiness,
  isTruthy
};
