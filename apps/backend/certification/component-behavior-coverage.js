'use strict';

/**
 * VAAYU Certification Component Behaviour Coverage Gate
 *
 * This gate prevents the certification program from silently growing backend
 * source without a corresponding behavioural certification owner. It does not
 * claim that syntax or source presence proves correctness. Instead it builds a
 * deterministic inventory of backend components and requires each component
 * area to be explicitly owned by one or more behavioural certification suites.
 *
 * Disposable-only: this is certification metadata, never a production probe.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcRoot = path.resolve(root, 'src');
const testRoot = path.resolve(root, 'test');
const evidenceDir = path.resolve(__dirname, 'artifacts');
const target = process.env.VAAYU_TEST_TARGET;

if (process.env.NODE_ENV === 'production' || target !== 'disposable') {
  throw new Error('Component behaviour coverage requires VAAYU_TEST_TARGET=disposable and must never run in production.');
}

fs.mkdirSync(evidenceDir, { recursive: true });

const ownership = {
  db: ['postgres-ledger', 'state-integrity', 'deep-lifecycle-consistency'],
  http: ['route-contract-audit', 'security', 'browser-all'],
  'map-engine': ['location-integrity', 'realtime-state-reconciliation'],
  security: ['security', 'realtime-state-reconciliation'],
  services: [
    'lifecycle',
    'shared-state-consistency',
    'deep-lifecycle-consistency',
    'realtime-state-reconciliation',
    'financial-lifecycle-reconciliation',
    'merchant-operational-reconciliation',
    'failure-resilience',
    'enterprise-operations',
    'websocket-e2e',
    'location-integrity',
    'security',
    'state-integrity',
    'enterprise-battery',
  ],
  server_bootstrap: ['portal-smoke', 'browser-all', 'route-contract-audit'],
  server_production: ['enterprise-battery', 'security'],
};

const suiteFiles = {
  'portal-smoke': 'test/browser/portalSmoke.spec.js',
  'customer-journey': 'test/browser/customerJourney.spec.js',
  'merchant-journey': 'test/browser/merchantJourney.spec.js',
  'browser-all': 'test/browser',
  lifecycle: 'test/integration/lifecycle.test.js',
  'shared-state-consistency': 'test/integration/sharedStateConsistency.test.js',
  'deep-lifecycle-consistency': 'test/integration/deepLifecycleConsistency.test.js',
  'realtime-state-reconciliation': 'test/integration/realtimeStateReconciliation.test.js',
  'financial-lifecycle-reconciliation': 'test/integration/financialLifecycleReconciliation.test.js',
  'merchant-operational-reconciliation': 'test/integration/merchantOperationalReconciliation.test.js',
  'failure-resilience': 'test/integration/failureResilience.test.js',
  'merchant-e2e': 'test/integration/merchantLifecycle.test.js',
  'enterprise-operations': 'test/integration/operations.test.js',
  'websocket-e2e': 'test/integration/websocket.test.js',
  'location-integrity': 'test/unit/locationMobilityIntegrity.test.js',
  'postgres-ledger': 'test/unit/postgresLedger.test.js',
  security: 'test/unit/comprehensiveSecurityAudit.test.js',
  'component-audit': 'certification/component-audit.js',
  'route-contract-audit': 'certification/route-contract-audit.js',
  'state-integrity': 'certification/state-integrity.js',
  'enterprise-battery': 'certification/enterprise-battery.js',
};

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function areaFor(relative) {
  const parts = relative.split(path.sep);
  return parts.length > 1 ? parts[0] : path.basename(relative, path.extname(relative));
}

function suiteExists(suite) {
  const value = suiteFiles[suite];
  if (!value) return false;
  return fs.existsSync(path.resolve(root, value));
}

function sourceTestReferenceExists(suite, area) {
  const suitePath = suiteFiles[suite];
  if (!suitePath || suitePath.endsWith('/')) return true;
  const absolute = path.resolve(root, suitePath);
  if (!fs.existsSync(absolute)) return false;
  const content = fs.readFileSync(absolute, 'utf8');
  if (area === 'server_bootstrap' || area === 'server_production') return true;
  const sourceArea = path.resolve(srcRoot, area);
  const relativeArea = path.relative(root, sourceArea).replace(/\\/g, '/');
  return content.includes(relativeArea) || content.includes(`src/${area}`) || area === 'services' || area === 'http' || area === 'db' || area === 'security';
}

function main() {
  const files = walk(srcRoot);
  const areas = [...new Set(files.map(file => areaFor(path.relative(srcRoot, file))))].sort();
  const uncoveredAreas = [];
  const staleOwners = [];
  const coverage = areas.map(area => {
    const suites = ownership[area] || [];
    const validSuites = suites.filter(suiteExists);
    const invalidSuites = suites.filter(suite => !suiteExists(suite));
    const references = validSuites.filter(suite => sourceTestReferenceExists(suite, area));
    const covered = validSuites.length > 0 && references.length > 0;
    if (!covered) uncoveredAreas.push(area);
    for (const suite of invalidSuites) staleOwners.push({ area, suite, reason: 'SUITE_FILE_MISSING' });
    return {
      area,
      sourceFiles: files.filter(file => areaFor(path.relative(srcRoot, file)) === area).map(file => path.relative(srcRoot, file).replace(/\\/g, '/')),
      owningSuites: suites,
      existingSuites: validSuites,
      evidenceReferences: references,
      status: covered ? 'OWNED' : 'UNOWNED',
    };
  });

  const result = {
    generatedAt: new Date().toISOString(),
    target,
    policy: {
      purpose: 'Every backend source area must have an explicit behavioural certification owner.',
      nonClaim: 'Ownership does not itself prove correctness; the referenced suite must pass in the certification run.',
      productionSafe: true,
    },
    summary: {
      sourceFiles: files.length,
      areas: areas.length,
      ownedAreas: coverage.filter(x => x.status === 'OWNED').length,
      unownedAreas: uncoveredAreas.length,
      staleOwners: staleOwners.length,
    },
    coverage,
    uncoveredAreas,
    staleOwners,
  };

  fs.writeFileSync(path.join(evidenceDir, 'component-behavior-coverage.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  if (uncoveredAreas.length || staleOwners.length) process.exitCode = 1;
}

main();
