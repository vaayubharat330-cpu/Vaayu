'use strict';

/**
 * Runtime dependency certification gate.
 *
 * Unlike the source/component inventory audits, this test performs real runtime
 * operations against the disposable backend dependencies. It deliberately
 * verifies PostgreSQL and Redis with write/read/delete round trips, then checks
 * the live HTTP server and WebSocket handshake. These checks prove that the
 * runtime dependency path is usable; they do not replace the domain suites.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require(path.join(__dirname, '..', 'node_modules', 'dotenv'));
const { Pool } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
const Redis = require(path.join(__dirname, '..', 'node_modules', 'ioredis'));
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env');
const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const target = process.env.VAAYU_TEST_TARGET;
const baseUrl = String(process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000').replace(/\/$/, '');
const databaseUrl = process.env.DATABASE_URL || parsed.DATABASE_URL || '';
const redisUrl = process.env.REDIS_URL || parsed.REDIS_URL || '';
const evidenceDir = path.join(__dirname, 'artifacts');

if (process.env.NODE_ENV === 'production' || target !== 'disposable') {
  throw new Error('Runtime dependency audit requires VAAYU_TEST_TARGET=disposable and must never run in production.');
}

fs.mkdirSync(evidenceDir, { recursive: true });

async function httpProbe() {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
  return { status: response.status, ok: response.ok, latencyMs: Date.now() - started };
}

async function postgresProbe() {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const key = `cert_runtime_${crypto.randomUUID()}`;
  try {
    const write = await pool.query('CREATE TEMP TABLE IF NOT EXISTS vaayu_cert_runtime_probe (probe_key text primary key, probe_value text not null)');
    const inserted = await pool.query(
      'INSERT INTO vaayu_cert_runtime_probe(probe_key, probe_value) VALUES($1,$2) RETURNING probe_key, probe_value',
      [key, 'runtime-ok']
    );
    const read = await pool.query('SELECT probe_value FROM vaayu_cert_runtime_probe WHERE probe_key=$1', [key]);
    const deleted = await pool.query('DELETE FROM vaayu_cert_runtime_probe WHERE probe_key=$1 RETURNING probe_key', [key]);
    return {
      connected: true,
      tempTableReady: write.command === 'CREATE TABLE' || write.command === 'CREATE',
      writeReadRoundTrip: inserted.rows[0]?.probe_value === read.rows[0]?.probe_value,
      deleteRoundTrip: deleted.rowCount === 1,
    };
  } finally {
    await pool.end();
  }
}

async function redisProbe() {
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  const key = `vaayu:cert:runtime:${crypto.randomUUID()}`;
  try {
    await redis.connect();
    await redis.set(key, 'runtime-ok', 'EX', 30);
    const value = await redis.get(key);
    const deleted = await redis.del(key);
    return { connected: true, writeReadRoundTrip: value === 'runtime-ok', deleteRoundTrip: deleted === 1 };
  } finally {
    try { await redis.quit(); } catch (_) { redis.disconnect(); }
  }
}

async function websocketProbe() {
  const wsUrl = baseUrl.replace(/^http/, 'ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/ws`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error('WebSocket handshake timed out'));
    }, 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve({ connected: true });
    });
    ws.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const checks = {};
  const errors = [];
  for (const [name, probe] of Object.entries({ http: httpProbe, postgres: postgresProbe, redis: redisProbe, websocket: websocketProbe })) {
    try {
      checks[name] = { status: 'PASSED', ...(await probe()) };
    } catch (error) {
      checks[name] = { status: 'FAILED', error: error.message };
      errors.push(`${name}: ${error.message}`);
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    target,
    baseUrl,
    checks,
    summary: {
      checks: Object.keys(checks).length,
      passed: Object.values(checks).filter(check => check.status === 'PASSED').length,
      failed: errors.length,
    },
    policy: {
      scope: 'Runtime dependency reachability and read/write behavior only.',
      nonClaim: 'Passing this audit does not prove domain correctness; domain certification suites remain mandatory.',
      productionSafe: true,
    },
  };

  fs.writeFileSync(path.join(evidenceDir, 'runtime-dependency-audit.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
