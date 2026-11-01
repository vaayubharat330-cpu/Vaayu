'use strict';

/**
 * Single source of truth for the VAAYU certification suite registry.
 *
 * The runner and certification metadata gates consume this registry so a suite
 * cannot silently exist in one place and disappear from another.
 */

const SUITES = Object.freeze([
  ['portal-smoke', ['test/browser/portalSmoke.spec.js']],
  ['customer-journey', ['test/browser/customerJourney.spec.js']],
  ['merchant-journey', ['test/browser/merchantJourney.spec.js']],
  ['browser-all', ['test/browser']],
  ['lifecycle', ['test/integration/lifecycle.test.js'], 'node'],
  ['shared-state-consistency', ['test/integration/sharedStateConsistency.test.js'], 'node'],
  ['deep-lifecycle-consistency', ['test/integration/deepLifecycleConsistency.test.js'], 'node'],
  ['realtime-state-reconciliation', ['test/integration/realtimeStateReconciliation.test.js'], 'node'],
  ['financial-lifecycle-reconciliation', ['test/integration/financialLifecycleReconciliation.test.js'], 'node'],
  ['merchant-operational-reconciliation', ['test/integration/merchantOperationalReconciliation.test.js'], 'node'],
  ['failure-resilience', ['test/integration/failureResilience.test.js'], 'node'],
  ['merchant-e2e', ['test/integration/merchantLifecycle.test.js'], 'node'],
  ['enterprise-operations', ['test/integration/operations.test.js'], 'node'],
  ['websocket-e2e', ['test/integration/websocket.test.js'], 'node'],
  ['location-integrity', ['test/unit/locationMobilityIntegrity.test.js'], 'node'],
  ['postgres-ledger', ['test/unit/postgresLedger.test.js'], 'node'],
  ['security', ['test/unit/comprehensiveSecurityAudit.test.js'], 'node'],
  ['component-audit', ['certification/component-audit.js'], 'node'],
  ['component-behavior-coverage', ['certification/component-behavior-coverage.js'], 'node'],
  ['behavioral-capability-audit', ['certification/behavioral-capability-audit.js'], 'node'],
  ['runtime-dependency-audit', ['certification/runtime-dependency-audit.js'], 'node'],
  ['route-contract-audit', ['certification/route-contract-audit.js'], 'node'],
  ['state-integrity', ['certification/state-integrity.js'], 'node'],
  ['enterprise-battery', ['certification/enterprise-battery.js'], 'node'],
  ['component-runtime-ownership-audit', ['certification/component-runtime-ownership-audit.js'], 'node'],
]);

const SUITE_NAMES = Object.freeze(SUITES.map(([name]) => name));

function getAllSuites() {
  return SUITES.map(([name, args, mode]) => [name, [...args], mode]);
}

function hasSuite(name) {
  return SUITE_NAMES.includes(name);
}

function getSuite(name) {
  return SUITES.find(([suiteName]) => suiteName === name) || null;
}

module.exports = { SUITES, SUITE_NAMES, getAllSuites, hasSuite, getSuite };
