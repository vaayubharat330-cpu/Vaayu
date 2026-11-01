'use strict';

/**
 * Broader behavioural certification battery for the disposable VAAYU backend.
 * Reuses the existing enterprise test battery instead of inventing duplicate
 * assertions. This runner adds structured evidence and keeps the destructive
 * safety boundary enforced.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const evidenceDir = path.resolve(__dirname, 'artifacts');
const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000';
const db = process.env.DATABASE_URL || 'postgresql://vaayu_cert:vaayu_cert@127.0.0.1:55432/vaayu_cert';
const redis = process.env.REDIS_URL || 'redis://127.0.0.1:56379';

if (process.env.NODE_ENV === 'production' || process.env.VAAYU_TEST_TARGET !== 'disposable') {
  throw new Error('Enterprise battery requires VAAYU_TEST_TARGET=disposable and must never run in production.');
}

function assertLoopback(value, label) {
  const host = new URL(value).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`${label} must target loopback disposable infrastructure; got ${host}`);
  }
}

assertLoopback(base, 'VAAYU_TEST_BASE');
assertLoopback(db, 'DATABASE_URL');
assertLoopback(redis, 'REDIS_URL');
fs.mkdirSync(evidenceDir, { recursive: true });

const startedAt = new Date().toISOString();
const output = [];
const child = spawn(process.execPath, ['scripts/run-all-tests.js'], {
  cwd: root,
  env: {
    ...process.env,
    VAAYU_TEST_TARGET: 'disposable',
    VAAYU_ALLOW_DESTRUCTIVE_TESTS: 'true',
    VAAYU_TEST_BASE: base,
    DATABASE_URL: db,
    REDIS_URL: redis,
    ENABLE_TEST_ENDPOINTS: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', chunk => { output.push(chunk.toString()); process.stdout.write(chunk); });
child.stderr.on('data', chunk => { output.push(chunk.toString()); process.stderr.write(chunk); });

child.on('close', (code, signal) => {
  const text = output.join('');
  const suiteLines = [...text.matchAll(/Running (test\/[^ ]+) \.\.\. (PASSED|FAILED)/g)]
    .map(match => ({ suite: match[1], status: match[2] }));
  const result = {
    name: 'enterprise-battery',
    startedAt,
    finishedAt: new Date().toISOString(),
    status: code === 0 ? 'PASSED' : 'FAILED',
    exitCode: code,
    signal,
    target: 'disposable',
    baseUrl: base,
    suites: suiteLines,
    suiteCount: suiteLines.length,
    passed: suiteLines.filter(x => x.status === 'PASSED').length,
    failed: suiteLines.filter(x => x.status === 'FAILED').length,
    output: text.slice(-100000),
  };
  fs.writeFileSync(path.join(evidenceDir, 'enterprise-battery.json'), JSON.stringify(result, null, 2));
  process.exit(code === 0 ? 0 : 1);
});

child.on('error', error => {
  fs.writeFileSync(path.join(evidenceDir, 'enterprise-battery.json'), JSON.stringify({
    name: 'enterprise-battery', startedAt, finishedAt: new Date().toISOString(),
    status: 'FAILED', error: error.message, target: 'disposable', baseUrl: base,
  }, null, 2));
  process.exit(1);
});
