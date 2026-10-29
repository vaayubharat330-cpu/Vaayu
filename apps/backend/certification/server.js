'use strict';

// VAAYU Certification Control Center.
// Read-only observer. It refuses to start outside the disposable certification target.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const Redis = require('ioredis');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

if (process.env.NODE_ENV === 'production' || process.env.VAAYU_TEST_TARGET !== 'disposable') {
  throw new Error('Certification observer requires VAAYU_TEST_TARGET=disposable and must never run in production.');
}

const HOST = process.env.CERTIFICATION_HOST || '127.0.0.1';
const PORT = Number(process.env.CERTIFICATION_PORT || 4100);
const BACKEND_URL = String(process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000').replace(/\/$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:56379';
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const EVIDENCE_DIR = path.resolve(__dirname, 'artifacts');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const suites = {
  'portal-smoke': 'Portal smoke — six entry surfaces',
  'customer-journey': 'Customer — registration, authentication and booking workspace',
  'merchant-journey': 'Merchant — registration, authentication and workspace',
  'browser-all': 'All browser certification tests',
  lifecycle: 'Backend delivery lifecycle E2E',
  'merchant-e2e': 'Backend merchant lifecycle E2E',
  'enterprise-operations': 'Enterprise operations E2E',
  'websocket-e2e': 'WebSocket E2E',
  'location-integrity': 'Location & mobility integrity',
  'postgres-ledger': 'PostgreSQL ledger certification',
  security: 'Comprehensive security certification',
};

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function safeError(error) { return error?.message || String(error); }

function readJsonFile(fileName) {
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(fileName)) return null;
  const file = path.join(EVIDENCE_DIR, fileName);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return { status: 'CORRUPT', error: safeError(error) }; }
}

function evidenceSummary() {
  const latest = readJsonFile('latest.json');
  const running = readJsonFile('running.json');
  const suiteResults = {};
  for (const key of Object.keys(suites)) {
    const item = readJsonFile(`${key}.json`);
    suiteResults[key] = item ? {
      status: item.status || 'COMPLETED',
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      exitCode: item.exitCode,
      mode: item.mode,
      error: item.error,
      outputTail: item.output ? String(item.output).slice(-5000) : undefined,
    } : { status: 'NOT_RUN' };
  }
  const historicalRuns = fs.readdirSync(EVIDENCE_DIR)
    .filter(name => /^cert-\d+\.json$/.test(name))
    .map(name => readJsonFile(name))
    .filter(Boolean)
    .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))
    .slice(0, 20)
    .map(item => ({ runId: item.runId, startedAt: item.startedAt, finishedAt: item.finishedAt, passed: item.passed, failed: item.failed, total: item.total }));
  return { latest, running, suites: suiteResults, historicalRuns };
}

async function backendHealth() {
  const started = Date.now();
  try {
    const response = await fetch(`${BACKEND_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) {}
    return { ok: response.ok, status: response.status, latencyMs: Date.now() - started, body };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: safeError(error) };
  }
}

async function postgresSnapshot() {
  if (!DATABASE_URL) return { ok: false, error: 'DATABASE_URL is not configured.' };
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 });
  try {
    const counts = await pool.query('SELECT collection, count(*)::int AS count FROM vaayu_records GROUP BY collection ORDER BY collection');
    const recent = await pool.query('SELECT collection, record_key, version, updated_at FROM vaayu_records ORDER BY updated_at DESC LIMIT 25');
    let database = null;
    try { database = new URL(DATABASE_URL).pathname.replace(/^\//, '') || null; } catch (_) {}
    return { ok: true, database, recordCountByCollection: counts.rows, recentRecords: recent.rows };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  } finally { await pool.end().catch(() => {}); }
}

async function redisHealth() {
  const redis = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 3000, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    const [pong, dbSize, info] = await Promise.all([redis.ping(), redis.dbsize(), redis.info('server')]);
    const version = String(info).match(/redis_version:([^\r\n]+)/)?.[1] || null;
    return { ok: pong === 'PONG', ping: pong, dbSize, version };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  } finally { redis.disconnect(); }
}

async function systemSnapshot() {
  const [backend, postgres, redis] = await Promise.all([backendHealth(), postgresSnapshot(), redisHealth()]);
  return {
    timestamp: new Date().toISOString(),
    certification: { target: process.env.VAAYU_TEST_TARGET, backendUrl: BACKEND_URL, controlCenterPort: PORT, mode: 'read-only-observer' },
    backend, postgres, redis, suites, evidence: evidenceSummary(),
  };
}

function dashboard(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') return dashboard(res);
    if (url.pathname === '/api/system') return json(res, 200, await systemSnapshot());
    if (url.pathname === '/api/database') return json(res, 200, await postgresSnapshot());
    if (url.pathname === '/api/evidence') return json(res, 200, evidenceSummary());
    if (url.pathname === '/api/runs') return json(res, 200, evidenceSummary().historicalRuns);
    if (url.pathname === '/api/suites') return json(res, 200, { suites });
    if (url.pathname.startsWith('/api/evidence/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/evidence/'.length));
      const item = readJsonFile(name);
      return item ? json(res, 200, item) : json(res, 404, { error: 'Evidence not found' });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) { return json(res, 500, { error: safeError(error) }); }
});

server.listen(PORT, HOST, () => {
  console.log(`[VAAYU CERT] Control Center listening on http://${HOST}:${PORT}`);
  console.log(`[VAAYU CERT] Observing backend ${BACKEND_URL}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
