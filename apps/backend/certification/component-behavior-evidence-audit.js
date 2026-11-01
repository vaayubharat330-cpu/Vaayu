'use strict';

/**
 * Component behavioural evidence audit.
 *
 * Ownership alone is not sufficient: this gate verifies that every executable
 * backend source file has identifiable evidence in at least one mapped
 * certification suite. Evidence can come from a direct source reference,
 * transitive local-module dependency from the suite, a component-area reference,
 * or an explicit behavioural evidence marker.
 *
 * Disposable-only metadata gate. Runtime correctness still requires the mapped
 * suites to execute and pass.
 */

const fs = require('fs');
const path = require('path');
const { getAllSuites } = require('./suite-registry');

const root = path.resolve(__dirname, '..');
const srcRoot = path.join(root, 'src');
const evidenceDir = path.join(__dirname, 'artifacts');
const target = process.env.VAAYU_TEST_TARGET;

if (process.env.NODE_ENV === 'production' || target !== 'disposable') {
  throw new Error('Component behavioural evidence audit requires VAAYU_TEST_TARGET=disposable.');
}

fs.mkdirSync(evidenceDir, { recursive: true });

const suiteRegistry = new Map(getAllSuites().map(([name, args]) => [name, args]));
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

function areaFor(relative) {
  const parts = relative.split('/');
  return parts.length > 1 ? parts[0] : 'root';
}

function suiteFiles(suite) {
  const args = suiteRegistry.get(suite) || [];
  return args.filter(value => /\.(js|cjs|mjs)$/.test(value));
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

function resolveLocalModule(fromFile, request) {
  if (!request || !request.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js'), path.join(base, 'index.cjs'), path.join(base, 'index.mjs')];
  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function localDependencies(entryFile) {
  const visited = new Set();
  const stack = [entryFile];
  const sourceFiles = new Set();

  while (stack.length) {
    const current = stack.pop();
    if (!current || visited.has(current) || !fs.existsSync(current)) continue;
    visited.add(current);
    if (current.startsWith(`${srcRoot}${path.sep}`)) sourceFiles.add(current);

    const content = readText(current);
    const requests = [];
    const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    const importPattern = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]['"]?\s*\)?/g;
    let match;
    while ((match = requirePattern.exec(content))) requests.push(match[1]);
    while ((match = importPattern.exec(content))) requests.push(match[1]);
    for (const request of requests) {
      const resolved = resolveLocalModule(current, request);
      if (resolved) stack.push(resolved);
    }
  }

  return sourceFiles;
}

function suiteEvidence(suite, relativeFile, area) {
  const files = suiteFiles(suite);
  const candidates = files
    .map(file => path.resolve(root, file))
    .filter(file => fs.existsSync(file));
  if (!candidates.length) return { suite, status: 'SUITE_SOURCE_MISSING', references: [] };

  const sourcePath = `src/${relativeFile}`;
  const areaPath = `src/${area}`;
  const references = [];
  for (const candidate of candidates) {
    const content = readText(candidate);
    const fileName = path.basename(candidate);
    const direct = content.includes(sourcePath);
    const areaReference = content.includes(areaPath);
    const dependencyFiles = localDependencies(candidate);
    const dependencyReference = dependencyFiles.has(path.join(srcRoot, relativeFile));
    const explicitMarker = new RegExp(`(?:component|coverage|exercise|behavio(?:u)?r|assert)[^\\n]{0,100}${area.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`, 'i').test(content);
    if (direct || areaReference || dependencyReference || explicitMarker) {
      references.push({
        testFile: path.relative(root, candidate).split(path.sep).join('/'),
        directFileReference: direct,
        areaReference,
        transitiveLocalDependencyReference: dependencyReference,
        explicitEvidenceMarker: explicitMarker,
        dependencyCount: dependencyFiles.size,
      });
    }
  }

  return {
    suite,
    status: references.length ? 'EVIDENCE_FOUND' : 'NO_MEANINGFUL_SOURCE_REFERENCE',
    references,
  };
}

function main() {
  const files = walk(srcRoot).map(file => path.relative(srcRoot, file).split(path.sep).join('/')).sort();
  const components = files.map(relativeFile => {
    const area = areaFor(relativeFile);
    const suites = ownership[area] || [];
    const evidence = suites.map(suite => suiteEvidence(suite, relativeFile, area));
    const meaningful = evidence.filter(item => item.status === 'EVIDENCE_FOUND');
    return {
      sourceFile: `apps/backend/src/${relativeFile}`,
      sourceArea: area,
      certificationSuites: suites,
      evidence,
      status: meaningful.length ? 'EVIDENCE_FOUND' : 'BEHAVIOURAL_EVIDENCE_GAP',
    };
  });

  const gaps = components.filter(component => component.status !== 'EVIDENCE_FOUND');
  const output = {
    generatedAt: new Date().toISOString(),
    target,
    summary: {
      sourceFiles: components.length,
      filesWithMeaningfulEvidence: components.length - gaps.length,
      behaviouralEvidenceGaps: gaps.length,
    },
    components,
    gaps: gaps.map(component => ({
      sourceFile: component.sourceFile,
      sourceArea: component.sourceArea,
      certificationSuites: component.certificationSuites,
      evidence: component.evidence,
    })),
    policy: {
      purpose: 'Every executable backend source file must have identifiable behavioural evidence in at least one mapped certification suite.',
      evidenceSources: ['direct source reference', 'transitive local-module dependency', 'component-area reference', 'explicit behavioural evidence marker'],
      nonClaim: 'Source references are evidence of test responsibility/exercise only; passing runtime certification is required for correctness.',
      conservative: true,
      productionSafe: true,
    },
  };

  fs.writeFileSync(path.join(evidenceDir, 'component-behavior-evidence-audit.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (gaps.length) process.exitCode = 1;
}

main();
