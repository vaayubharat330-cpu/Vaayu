'use strict';

/**
 * Certification preflight gate.
 *
 * Verifies that the certification registry is internally executable before
 * spending time on behavioural suites. It does not claim runtime correctness.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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

function walkJavaScript(relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return /\.(js|cjs|mjs)$/.test(absolute) ? [relativePath] : [];

  const files = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...walkJavaScript(child));
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) files.push(child);
  }
  return files;
}

function syntaxCheck(relativePath) {
  const absolute = path.resolve(root, relativePath);
  const result = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
  return {
    path: relativePath,
    ok: result.status === 0,
    exitCode: result.status,
    error: result.error ? result.error.message : null,
    stderr: result.stderr ? result.stderr.trim() : '',
  };
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

  const syntaxTargets = entries.flatMap(entry => entry.exists ? walkJavaScript(entry.path).map(file => ({
    suite: entry.suite,
    controlFile: false,
    mode: entry.mode,
    path: file,
  })) : []);

  const requiredFiles = ['certification/run-certification.js', 'certification/certification-integrity-audit.js', 'certification/server.js'];
  const requiredFileChecks = requiredFiles.map(inspectEntry);
  const requiredSyntaxTargets = requiredFileChecks
    .filter(entry => entry.exists && entry.type === 'file' && /\.(js|cjs|mjs)$/.test(entry.path))
    .map(entry => ({ suite: null, controlFile: true, mode: null, path: entry.path }));

  const syntaxTargetsByPath = new Map([...syntaxTargets, ...requiredSyntaxTargets].map(entry => [entry.path, entry]));
  const syntaxChecks = [...syntaxTargetsByPath.values()].map(entry => ({ ...entry, ...syntaxCheck(entry.path) }));
  const syntaxFailures = syntaxChecks.filter(check => !check.ok);
  const missingRequiredFiles = requiredFileChecks.filter(item => !item.exists);

  const checks = [
    { name: 'unique-suite-names', ok: duplicateNames.length === 0, duplicateNames },
    { name: 'valid-suite-modes', ok: invalidModes.length === 0, invalidModes },
    { name: 'registered-suite-sources-exist', ok: missingEntries.length === 0, missingEntries },
    { name: 'registered-suite-directories-nonempty', ok: emptyDirectories.length === 0, emptyDirectories },
    { name: 'registered-certification-sources-parse', ok: syntaxFailures.length === 0, syntaxFailures },
    { name: 'certification-control-files-exist', ok: missingRequiredFiles.length === 0, missingRequiredFiles },
  ];

  const output = {
    generatedAt: new Date().toISOString(),
    target,
    suiteCount: suites.length,
    suiteNames: names,
    entries,
    syntaxChecks,
    requiredFileChecks,
    checks,
    summary: {
      checks: checks.length,
      passed: checks.filter(check => check.ok).length,
      failed: checks.filter(check => !check.ok).length,
      registeredSourceFiles: syntaxChecks.filter(check => !check.controlFile).length,
      syntaxTargetsChecked: syntaxChecks.length,
      syntaxValid: syntaxFailures.length === 0,
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
