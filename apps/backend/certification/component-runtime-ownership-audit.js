'use strict';

/**
 * Backend component runtime ownership audit.
 *
 * Maps every discovered executable backend source file to explicit
 * certification ownership. Area-level ownership alone can hide an untested
 * file behind an unrelated test, so this gate records ownership at file level.
 *
 * This is an evidence gate only. Runtime correctness still requires the mapped
 * suites to execute and pass in the disposable certification environment.
 */

const fs = require('fs');
const path = require('path');
const { SUITE_NAMES } = require('./suite-registry');

const root = path.resolve(__dirname, '..');
const srcRoot = path.join(root, 'src');
const evidenceDir = path.join(__dirname, 'artifacts');
const target = process.env.VAAYU_TEST_TARGET;

if (process.env.NODE_ENV === 'production' || target !== 'disposable') {
  throw new Error('Component runtime ownership audit requires VAAYU_TEST_TARGET=disposable.');
}

fs.mkdirSync(evidenceDir, { recursive: true });

const allSuites = new Set(SUITE_NAMES);
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

function suitesFor(relativePath) {
  const parts = relativePath.split('/');
  const area = parts.length > 1 ? parts[0] : 'root';
  return ownership[area] || [];
}

function main() {
  const files = walk(srcRoot);
  const components = files.map(file => {
    const relative = path.relative(srcRoot, file).split(path.sep).join('/');
    const suites = suitesFor(relative);
    const invalidSuites = suites.filter(suite => !allSuites.has(suite));
    return {
      sourceFile: path.relative(root, file).split(path.sep).join('/'),
      sourceArea: relative.includes('/') ? relative.split('/')[0] : 'root',
      certificationSuites: suites,
      invalidSuites,
      status: suites.length > 0 && invalidSuites.length === 0 ? 'OWNED' : 'OWNERSHIP_GAP',
    };
  }).sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));

  const gaps = components.filter(component => component.status !== 'OWNED');
  const areaSummary = {};
  for (const component of components) {
    const area = component.sourceArea;
    if (!areaSummary[area]) areaSummary[area] = { sourceFiles: 0, ownedFiles: 0, ownershipGaps: 0 };
    areaSummary[area].sourceFiles += 1;
    if (component.status === 'OWNED') areaSummary[area].ownedFiles += 1;
    else areaSummary[area].ownershipGaps += 1;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    target,
    selectedSuites: String(process.env.CERTIFICATION_SUITES || '').split(',').map(x => x.trim()).filter(Boolean),
    registeredSuiteCount: SUITE_NAMES.length,
    summary: {
      backendAreas: Object.keys(areaSummary).length,
      sourceFiles: components.length,
      ownedFiles: components.length - gaps.length,
      ownershipGaps: gaps.length,
    },
    areaSummary,
    components,
    policy: {
      purpose: 'Every discovered executable backend source file must have explicit certification ownership.',
      nonClaim: 'Ownership proves test responsibility, not runtime correctness; mapped suites must pass.',
      discoveryScope: 'Executable .js/.cjs/.mjs files under apps/backend/src.',
      nonExecutableAssetsExcluded: 'CSS and other non-executable source assets are outside this runtime ownership gate.',
      suiteRegistrySourceOfTruth: 'apps/backend/certification/suite-registry.js',
      productionSafe: true,
    },
  };

  fs.writeFileSync(path.join(evidenceDir, 'component-runtime-ownership-audit.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (gaps.length) process.exitCode = 1;
}

main();
