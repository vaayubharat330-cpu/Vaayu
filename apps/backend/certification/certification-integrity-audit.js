'use strict';

/**
 * Certification integrity gate.
 *
 * Prevents the Control Center from presenting an incomplete or stale
 * certification run as authoritative. It compares the runner's declared
 * suites with the Control Center registry, verifies every declared suite has
 * a result in the latest run, and requires all selected suites to pass.
 *
 * This is a meta-certification gate: it does not replace the underlying tests.
 */

const fs = require('fs');
const path = require('path');

const certificationRoot = path.resolve(__dirname);
const evidenceDir = path.join(certificationRoot, 'artifacts');
const runnerFile = path.join(certificationRoot, 'run-certification.js');
const serverFile = path.join(certificationRoot, 'server.js');
const target = process.env.VAAYU_TEST_TARGET;

if (process.env.NODE_ENV === 'production' || target !== 'disposable') {
  throw new Error('Certification integrity audit requires VAAYU_TEST_TARGET=disposable and must never run in production.');
}

fs.mkdirSync(evidenceDir, { recursive: true });

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function extractRunnerSuites(content) {
  const names = [];
  const re = /\['([^']+)',\s*\[/g;
  let match;
  while ((match = re.exec(content))) names.push(match[1]);
  return [...new Set(names)];
}

function extractServerSuites(content) {
  const block = content.match(/const suites = \{([\s\S]*?)\n\};/);
  if (!block) return [];
  const names = [];
  const re = /['"]([^'"]+)['"]\s*:/g;
  let match;
  while ((match = re.exec(block[1]))) names.push(match[1]);
  const bare = block[1].match(/^\s{2}([a-zA-Z][\w-]*)\s*:/gm) || [];
  for (const item of bare) names.push(item.trim().replace(/:$/, ''));
  return [...new Set(names)];
}

function latestRun() {
  const file = path.join(evidenceDir, 'latest.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(read(file)); } catch (_) { return null; }
}

function main() {
  const runnerContent = read(runnerFile);
  const serverContent = read(serverFile);
  const runnerSuites = extractRunnerSuites(runnerContent);
  const serverSuites = extractServerSuites(serverContent);
  const latest = latestRun();
  const resultMap = new Map((latest?.results || []).map(result => [result.name, result]));

  const missingFromServer = runnerSuites.filter(name => !serverSuites.includes(name));
  const missingFromRunner = serverSuites.filter(name => !runnerSuites.includes(name));
  const missingResults = runnerSuites.filter(name => !resultMap.has(name));
  const failedResults = runnerSuites
    .map(name => resultMap.get(name))
    .filter(result => result && result.status !== 'PASSED')
    .map(result => ({ name: result.name, status: result.status, exitCode: result.exitCode, error: result.error }));

  const checks = [
    { name: 'runner-server-suite-parity', ok: missingFromServer.length === 0 && missingFromRunner.length === 0, missingFromServer, missingFromRunner },
    { name: 'latest-run-exists', ok: Boolean(latest?.runId && Array.isArray(latest.results)) },
    { name: 'latest-run-suite-completeness', ok: missingResults.length === 0, missingResults },
    { name: 'latest-run-all-pass', ok: failedResults.length === 0, failedResults },
    { name: 'latest-run-target-disposable', ok: latest?.target === 'disposable', actualTarget: latest?.target || null },
  ];

  const output = {
    generatedAt: new Date().toISOString(),
    target,
    latestRunId: latest?.runId || null,
    runnerSuiteCount: runnerSuites.length,
    controlCenterSuiteCount: serverSuites.length,
    checks,
    summary: {
      checks: checks.length,
      passed: checks.filter(check => check.ok).length,
      failed: checks.filter(check => !check.ok).length,
      certificationAuthoritative: checks.every(check => check.ok),
    },
    policy: {
      purpose: 'Prevent stale, partial, or registry-divergent certification evidence from being treated as authoritative.',
      nonClaim: 'This gate validates certification evidence integrity; it does not replace the underlying behavioural suites.',
      productionSafe: true,
    },
  };

  fs.writeFileSync(path.join(evidenceDir, 'certification-integrity-evidence.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (!output.summary.certificationAuthoritative) process.exitCode = 1;
}

main();
