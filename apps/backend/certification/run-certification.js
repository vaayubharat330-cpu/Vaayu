'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const evidenceDir = path.resolve(__dirname, 'artifacts');
fs.mkdirSync(evidenceDir, { recursive: true });

const allSuites = [
  ['portal-smoke', ['test/browser/portalSmoke.spec.js']],
  ['customer-journey', ['test/browser/customerJourney.spec.js']],
  ['merchant-journey', ['test/browser/merchantJourney.spec.js']],
  ['browser-all', ['test/browser']],
  ['lifecycle', ['test/integration/lifecycle.test.js'], 'node'],
  ['merchant-e2e', ['test/integration/merchantLifecycle.test.js'], 'node'],
  ['enterprise-operations', ['test/integration/operations.test.js'], 'node'],
  ['websocket-e2e', ['test/integration/websocket.test.js'], 'node'],
  ['location-integrity', ['test/unit/locationMobilityIntegrity.test.js'], 'node'],
  ['postgres-ledger', ['test/unit/postgresLedger.test.js'], 'node'],
  ['security', ['test/unit/comprehensiveSecurityAudit.test.js'], 'node'],
];

const requested = String(process.env.CERTIFICATION_SUITES || '')
  .split(',').map(x => x.trim()).filter(Boolean);
const suites = requested.length
  ? allSuites.filter(([name]) => requested.includes(name))
  : allSuites;

function writeJson(name, value) {
  fs.writeFileSync(path.join(evidenceDir, name), JSON.stringify(value, null, 2));
}

function run(name, args, mode = 'playwright') {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const output = [];
    const command = mode === 'node'
      ? [process.execPath, ['--test', ...args]]
      : [process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...args, '--config', 'playwright.config.js']];

    const child = spawn(command[0], command[1], {
      cwd: root,
      env: {
        ...process.env,
        PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL || process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const collect = chunk => output.push(chunk.toString());
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => {
      const result = {
        name, mode, startedAt, finishedAt: new Date().toISOString(),
        status: 'FAILED', exitCode: null, signal: null,
        error: error.message, output: output.join('').slice(-50000),
      };
      writeJson(`${name}.json`, result);
      resolve(result);
    });
    child.on('close', (code, signal) => {
      const result = {
        name, mode, startedAt, finishedAt: new Date().toISOString(),
        status: code === 0 ? 'PASSED' : 'FAILED', exitCode: code, signal,
        output: output.join('').slice(-50000),
      };
      writeJson(`${name}.json`, result);
      resolve(result);
    });
  });
}

function collectArtifacts() {
  const dirs = ['test-results', 'playwright-report'];
  const files = [];
  for (const dir of dirs) {
    const base = path.resolve(root, dir);
    if (!fs.existsSync(base)) continue;
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push({ path: path.relative(root, full), bytes: fs.statSync(full).size });
      }
    };
    walk(base);
  }
  return files.slice(-1000);
}

function assertEnvironment() {
  if (process.env.NODE_ENV === 'production' || process.env.VAAYU_TEST_TARGET !== 'disposable') {
    throw new Error('Certification runner requires VAAYU_TEST_TARGET=disposable and must never run in production.');
  }
  if (!process.env.VAAYU_TEST_BASE) {
    process.env.VAAYU_TEST_BASE = 'http://127.0.0.1:4000';
  }
}

(async () => {
  assertEnvironment();
  if (!suites.length) {
    throw new Error(`No valid certification suites selected. Available: ${allSuites.map(x => x[0]).join(', ')}`);
  }

  const runId = `cert-${Date.now()}`;
  const startedAt = new Date().toISOString();
  writeJson('running.json', {
    runId, startedAt, status: 'RUNNING', total: suites.length,
    selectedSuites: suites.map(x => x[0]), target: process.env.VAAYU_TEST_TARGET,
  });

  const results = [];
  for (const [name, args, mode] of suites) {
    results.push(await run(name, args, mode));
  }

  const summary = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    target: process.env.VAAYU_TEST_TARGET,
    baseUrl: process.env.VAAYU_TEST_BASE,
    results,
    passed: results.filter(r => r.status === 'PASSED').length,
    failed: results.filter(r => r.status === 'FAILED').length,
    total: results.length,
    artifacts: collectArtifacts(),
  };

  writeJson('latest.json', summary);
  writeJson(`${runId}.json`, summary);
  try { fs.unlinkSync(path.join(evidenceDir, 'running.json')); } catch (_) {}
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failed === 0 ? 0 : 1);
})().catch(error => {
  writeJson('latest.json', {
    runId: `cert-${Date.now()}`,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    target: process.env.VAAYU_TEST_TARGET || null,
    status: 'FAILED', error: error.message,
  });
  console.error(error);
  process.exit(1);
});
