'use strict';

/**
 * Backend component runtime ownership audit.
 *
 * Maps discovered backend source areas to certification suites using explicit
 * source-path evidence. This prevents a component from being considered
 * covered merely because another, unrelated backend test passed.
 *
 * This is an evidence gate only. Runtime correctness still requires the mapped
 * suites to execute and pass in the disposable certification environment.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcRoot = path.join(root, 'src');
const evidenceDir = path.join(__dirname, 'artifacts');
const target = process.env.VAAYU_TEST_TARGET;

if (process.env.NODE_ENV === 'production' || target !== 'disposable') {
  throw new Error('Component runtime ownership audit requires VAAYU_TEST_TARGET=disposable.');
}

fs.mkdirSync(evidenceDir, { recursive: true });

const ownership = {
  db: ['postgres-ledger', 'state-integrity', 'runtime-dependency-audit'],
  http: ['route-contract-audit', 'security', 'browser-all'],
  'map-engine': ['location-integrity', 'enterprise-operations'],
  security: ['security', 'websocket-e2e', 'failure-resilience'],
  services: [
    'lifecycle', 'deep-lifecycle-consistency', 'enterprise-operations',
    'financial-lifecycle-reconciliation', 'merchant-operational-reconciliation',
    'realtime-state-reconciliation', 'failure-resilience', 'enterprise-battery'
  ],
  root: ['lifecycle', 'component-audit', 'behavioral-capability-audit', 'runtime-dependency-audit']
};

const runnerSuites = new Set([
  'portal-smoke', 'customer-journey', 'merchant-journey', 'browser-all',
  'lifecycle', 'shared-state-consistency', 'deep-lifecycle-consistency',
  'realtime-state-reconciliation', 'financial-lifecycle-reconciliation',
  'merchant-operational-reconciliation', 'failure-resilience', 'merchant-e2e',
  'enterprise-operations', 'websocket-e2e', 'location-integrity',
  'postgres-ledger', 'security', 'component-audit', 'component-behavior-coverage',
  'behavioral-capability-audit', 'runtime-dependency-audit', 'route-contract-audit',
  'state-integrity', 'enterprise-battery'
]);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) result.push(full);
  }
  return result;
}

function main() {
  const files = walk(srcRoot);
  const areas = new Map();
  for (const file of files) {
    const relative = path.relative(srcRoot, file).split(path.sep);
    const area = relative.length > 1 ? relative[0] : 'root';
    if (!areas.has(area)) areas.set(area, []);
    areas.get(area).push(path.relative(root, file));
  }

  const results = [...areas.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([area, filesInArea]) => {
    const suites = ownership[area] || [];
    const invalidSuites = suites.filter(suite => !runnerSuites.has(suite));
    const covered = suites.length > 0 && invalidSuites.length === 0;
    return {
      area,
      sourceFiles: filesInArea.length,
      sourceSample: filesInArea.slice(0, 12),
      certificationSuites: suites,
      invalidSuites,
      status: covered ? 'OWNED' : 'OWNERSHIP_GAP',
    };
  });

  const gaps = results.filter(result => result.status !== 'OWNED');
  const output = {
    generatedAt: new Date().toISOString(),
    target,
    summary: {
      backendAreas: results.length,
      ownedAreas: results.length - gaps.length,
      ownershipGaps: gaps.length,
      sourceFiles: files.length,
    },
    areas: results,
    policy: {
      purpose: 'Every discovered backend source area must have explicit certification ownership.',
      nonClaim: 'Ownership proves test responsibility, not runtime correctness; mapped suites must pass.',
      productionSafe: true,
    },
  };

  fs.writeFileSync(path.join(evidenceDir, 'component-runtime-ownership-audit.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (gaps.length) process.exitCode = 1;
}

main();
