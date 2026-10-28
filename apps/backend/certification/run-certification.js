'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const evidenceDir = path.resolve(__dirname, 'artifacts');
fs.mkdirSync(evidenceDir, { recursive: true });

const suites = [
  ['portal-smoke', ['test/browser/portalSmoke.spec.js']],
  ['customer-journey', ['test/browser/customerJourney.spec.js']],
  ['merchant-journey', ['test/browser/merchantJourney.spec.js']],
];

function run(name, args) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const output = [];
    const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...args, '--config', 'playwright.config.js'], {
      cwd: root,
      env: { ...process.env, PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL || process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = chunk => output.push(chunk.toString());
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code, signal) => {
      const result = { name, startedAt, finishedAt: new Date().toISOString(), status: code === 0 ? 'PASSED' : 'FAILED', exitCode: code, signal, output: output.join('').slice(-50000) };
      fs.writeFileSync(path.join(evidenceDir, `${name}.json`), JSON.stringify(result, null, 2));
      resolve(result);
    });
  });
}

(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.VAAYU_TEST_TARGET !== 'disposable') {
    throw new Error('Certification runner requires VAAYU_TEST_TARGET=disposable and must never run in production.');
  }
  const results = [];
  for (const [name, args] of suites) results.push(await run(name, args));
  const summary = { startedAt: results[0]?.startedAt || new Date().toISOString(), finishedAt: new Date().toISOString(), results, passed: results.filter(r => r.status === 'PASSED').length, total: results.length };
  fs.writeFileSync(path.join(evidenceDir, 'latest.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(results.every(r => r.status === 'PASSED') ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });
