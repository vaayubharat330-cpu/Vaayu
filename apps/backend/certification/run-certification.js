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
];

const requested = String(process.env.CERTIFICATION_SUITES || '').split(',').map(x => x.trim()).filter(Boolean);
const suites = requested.length ? allSuites.filter(([name]) => requested.includes(name)) : allSuites;

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
    child.on('close', (code, signal) => {
      const result = {
        name,
        mode,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: code === 0 ? 'PASSED' : 'FAILED',
        exitCode: code,
        signal,
        output: output.join('').slice(-50000),
      };
      fs.writeFileSync(path.join(evidenceDir, `${name}.json`), JSON.stringify(result, null, 2));
      resolve(result);
    });
    child.on('error', error => {
      const result = { name, mode, startedAt, finishedAt: new Date().toISOString(), status: 'FAILED', exitCode: null, error: error.message, output: output.join('').slice(-50000) };
      fs.writeFileSync(path.join(evidenceDir, `${name}.json`), JSON.stringify(result, null, 2));
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
        else files.push(path.relative(root, full));
      }
    };
    walk(base);
  }
  return files.slice(-500);
}

(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.VAAYU_TEST_TARGET !== 'disposable') {
    throw new Error('Certification runner requires VAAYU_TEST_TARGET=disposable and must never run in production.');
  }
  if (!suites.length) throw new Error(`No valid certification suites selected. Available: ${allSuites.map(x => x[0]).join(', ')}`);
  const results = [];
  for (const [name, args, mode] of suites) results.push(await run(name, args, mode));
  const summary = {
    startedAt: results[0]?.startedAt || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    results,
    passed: results.filter(r => r.status === 'PASSED').length,
    failed: results.filter(r => r.status === 'FAILED').length,
    total: results.length,
    artifacts: collectArtifacts(),
  };
  fs.writeFileSync(path.join(evidenceDir, 'latest.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failed === 0 ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });
