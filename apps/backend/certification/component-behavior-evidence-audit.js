'use strict';

/**
 * Component behavioural evidence audit.
 *
 * Ownership alone is not sufficient: this gate verifies that every executable
 * backend source file has at least one mapped certification suite whose source
 * actually references the component area/file or contains an explicit
 * behavioural evidence marker. It is intentionally conservative and reports
 * evidence gaps instead of assuming a suite name implies coverage.
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

function sourceText(relativeFile) {
  return fs.readFileSync(path.join(srcRoot, relativeFile), 'utf8');
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
    const content = fs.readFileSync(candidate, 'utf8');
    const fileName = path.basename(candidate);
    const direct = content.includes(sourcePath);
    const areaReference = content.includes(areaPath);
    const explicitMarker = new RegExp(`(?:component|coverage|exercise|behavio(?:u)?r|assert)[^\\n]{0,100}${area.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`, 'i').test(content);
    if (direct || areaReference || explicitMarker) {
      references.push({
        testFile: path.relative(root, candidate).split(path.sep).join('/'),
        directFileReference: direct,
        areaReference,
        explicitEvidenceMarker: explicitMarker,
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
