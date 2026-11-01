'use strict';

/**
 * VAAYU behavioural capability evidence gate.
 *
 * This is intentionally an evidence gate, not a fake runtime health check.
 * It verifies that critical backend capabilities have a named certification
 * suite, that the suite exists, and that the suite contains executable test
 * assertions plus domain-specific evidence markers. Actual correctness still
 * depends on the suite passing in the disposable certification run.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const evidenceDir = path.resolve(__dirname, 'artifacts');
const target = process.env.VAAYU_TEST_TARGET;

if (process.env.NODE_ENV === 'production' || target !== 'disposable') {
  throw new Error('Behavioural capability audit requires VAAYU_TEST_TARGET=disposable and must never run in production.');
}

fs.mkdirSync(evidenceDir, { recursive: true });

const capabilities = {
  authentication: {
    suite: 'security',
    file: 'test/unit/comprehensiveSecurityAudit.test.js',
    markers: ['auth', 'jwt', 'otp'],
  },
  authorization: {
    suite: 'security',
    file: 'test/unit/comprehensiveSecurityAudit.test.js',
    markers: ['forbidden', 'role', 'authorization'],
  },
  persistence: {
    suite: 'postgres-ledger',
    file: 'test/unit/postgresLedger.test.js',
    markers: ['postgres', 'transaction', 'ledger'],
  },
  redis_state: {
    suite: 'state-integrity',
    file: 'certification/state-integrity.js',
    markers: ['redis', 'state'],
  },
  delivery_lifecycle: {
    suite: 'deep-lifecycle-consistency',
    file: 'test/integration/deepLifecycleConsistency.test.js',
    markers: ['OTP', 'geofence', 'DELIVERED'],
  },
  realtime: {
    suite: 'realtime-state-reconciliation',
    file: 'test/integration/realtimeStateReconciliation.test.js',
    markers: ['WebSocket', 'version', 'telemetry'],
  },
  dispatch: {
    suite: 'enterprise-operations',
    file: 'test/integration/operations.test.js',
    markers: ['dispatch', 'driver', 'trip'],
  },
  financial: {
    suite: 'financial-lifecycle-reconciliation',
    file: 'test/integration/financialLifecycleReconciliation.test.js',
    markers: ['wallet', 'ledger', 'settlement'],
  },
  merchant_operations: {
    suite: 'merchant-operational-reconciliation',
    file: 'test/integration/merchantOperationalReconciliation.test.js',
    markers: ['merchant', 'proof', 'DELIVERED'],
  },
  location_integrity: {
    suite: 'location-integrity',
    file: 'test/unit/locationMobilityIntegrity.test.js',
    markers: ['location', 'geofence', 'distance'],
  },
  browser_surfaces: {
    suite: 'browser-all',
    file: 'test/browser/multiRoleSurface.spec.js',
    markers: ['customer', 'driver', 'merchant', 'admin'],
  },
  websocket_security: {
    suite: 'websocket-e2e',
    file: 'test/integration/websocket.test.js',
    markers: ['WebSocket', 'room', '401'],
  },
  failure_resilience: {
    suite: 'failure-resilience',
    file: 'test/integration/failureResilience.test.js',
    markers: ['failure', 'state', 'forbidden'],
  },
  api_contract: {
    suite: 'route-contract-audit',
    file: 'certification/route-contract-audit.js',
    markers: ['runtime', 'route', '404'],
  },
};

const runnerSuites = new Set([
  'portal-smoke', 'customer-journey', 'merchant-journey', 'browser-all',
  'lifecycle', 'shared-state-consistency', 'deep-lifecycle-consistency',
  'realtime-state-reconciliation', 'financial-lifecycle-reconciliation',
  'merchant-operational-reconciliation', 'failure-resilience', 'merchant-e2e',
  'enterprise-operations', 'websocket-e2e', 'location-integrity',
  'postgres-ledger', 'security', 'component-audit', 'route-contract-audit',
  'state-integrity', 'enterprise-battery', 'component-behavior-coverage',
  'behavioral-capability-audit',
]);

function assertionCount(content) {
  return (content.match(/\b(?:assert|expect|strictEqual|deepStrictEqual|ok|equal|notEqual|t\.assert|t\.equal|t\.deepEqual|t\.ok)\b/g) || []).length;
}

function main() {
  const results = Object.entries(capabilities).map(([name, spec]) => {
    const absolute = path.resolve(root, spec.file);
    const exists = fs.existsSync(absolute);
    const content = exists ? fs.readFileSync(absolute, 'utf8') : '';
    const lower = content.toLowerCase();
    const missingMarkers = spec.markers.filter(marker => !lower.includes(marker.toLowerCase()));
    const assertions = assertionCount(content);
    const suiteRegistered = runnerSuites.has(spec.suite);
    const passed = exists && suiteRegistered && assertions > 0 && missingMarkers.length === 0;
    return {
      capability: name,
      suite: spec.suite,
      file: spec.file,
      exists,
      suiteRegistered,
      assertions,
      requiredMarkers: spec.markers,
      missingMarkers,
      status: passed ? 'EVIDENCE_PRESENT' : 'EVIDENCE_GAP',
    };
  });

  const gaps = results.filter(result => result.status !== 'EVIDENCE_PRESENT');
  const output = {
    generatedAt: new Date().toISOString(),
    target,
    policy: {
      purpose: 'Every critical backend capability must have executable behavioural evidence.',
      nonClaim: 'Static evidence does not prove runtime correctness; the named suite must also pass.',
      productionSafe: true,
    },
    summary: {
      capabilities: results.length,
      evidencePresent: results.length - gaps.length,
      evidenceGaps: gaps.length,
    },
    capabilities: results,
    evidenceGaps: gaps,
  };

  fs.writeFileSync(path.join(evidenceDir, 'behavioral-capability-audit.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (gaps.length) process.exitCode = 1;
}

main();
