'use strict';

/**
 * Certification preflight gate.
 *
 * Verifies that the certification registry is internally executable before
 * spending time on behavioural suites. It does not claim runtime correctness.
 */
const fs = require('fs');
const path = require('path');
const { getAllSuites } = require('./suite-registry');

const root = path.resolve(__dirname, '..');
const evidenceDir = path.resolve(__dirname, 'artifacts');
const target = process.env.VAAYU_TEST_TARGET;

if (process.env.NODE_ENV === 'production' || target !== 'disposable') {
  throw new Error('Certification preflight requires VAAYU_TEST_TARGET=disposable and must never run in production.');
}

fs.mkdirSync(evidenceDir, { recursive: true });

function inspectEntry(relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (!fs.existsSync(absolute)) return { path: relativePath, exists: false, type: 'missing' };
  const stat = fs.statSync(absolute);
  return { path: relativePath, exists: true, type: stat.isDirectory() ? 'directory' : 'file', entries: stat.isDirectory() ? fs.readdirSync(absolute).length : undefined };
}

function main() {
  const suites = getAllSuites();
  const names = suites.map(([name]) => name);
  const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
  const invalidModes = suites
    .filter(([, , mode]) => mode !== undefined && mode !== 'node' && mode !== 'playwright')
    .map(([name, , mode]) => ({ name, mode }));
  const entries = suites.flatMap(([name, args, mode]) => args.map(arg => ({ suite: name, mode: mode || 'playwright', ...inspectEntry(arg) })));
  const missingEntries = entries.filter(entry => !entry.exists);
  const emptyDirectories = entries.filter(entry => entry.exists && entry.type === 'directory' && Number(entry.entries) === 0);
  const requiredFiles = ['certification/run-certification.js', 'certification/certification-integrity-audit.js', 'certification/server.js'];
  const requiredFileChecks = requiredFiles.map(inspectEntry);
  const missingRequiredFiles = requiredFileChecks.filter(item => !item.exists);

  const checks = [
    { name: 'unique-suite-names', ok: duplicateNames.length === 0, duplicateNames },
    { name: 'valid-suite-modes', ok: invalidModes.length === 0, invalidModes },
    { name: 'registered-suite-sources-exist', ok: missingEntries.length === 0, missingEntries },
    { name: 'registered-suite-directories-nonempty', ok: emptyDirectories.length === 0, emptyDirectories },
    { name: 'certification-control-files-exist', ok: missingRequiredFiles.length === 0, missingRequiredFiles },
  ];

  const output = {
    generatedAt: new Date().toISOString(),
    target,
    suiteCount: suites.length,
    suiteNames: names,
    entries,
    requiredFileChecks,
    checks,
    summary: {
      checks: checks.length,
      passed: checks.filter(check => check.ok).length,
      failed: checks.filter(check => !check.ok).length,
      preflightPassed: checks.every(check => check.ok),
    },
    policy: {
      purpose: 'Reject broken or stale certification configuration before behavioural execution.',
      nonClaim: 'Preflight validates certification machinery and source availability; it does not prove application correctness.',
      productionSafe: true,
    },
  };

  fs.writeFileSync(path.join(evidenceDir, 'certification-preflight.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (!output.summary.preflightPassed) process.exitCode = 1;
}

main();
