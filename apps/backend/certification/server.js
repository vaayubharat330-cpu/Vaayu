'use strict';

// VAAYU Certification Control Center.
// Read-only by default. It refuses to start outside the disposable certification target.
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
  'portal-smoke': 'Portal smoke — all six entry surfaces',
  'customer-journey': 'Customer — registration, authentication and booking workspace',
  'merchant-journey': 'Merchant — registration, authentication and workspace',
  browser: 'All browser certification tests',
  lifecycle: 'Backend delivery lifecycle E2E',
  merchant_e2e: 'Backend merchant lifecycle E2E',
};

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function safeError(error) {
  return error?.message || String(error);
}

function evidenceFiles() {
  try {
    return fs.readdirSync(EVIDENCE_DIR).filter(name => name.endsWith('.json')).sort();
  } catch (_) {
    return [];
  }
}

function readEvidence(name) {
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) return null;
  const file = path.join(EVIDENCE_DIR, name);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return { error: safeError(error) }; }
}

function evidenceSummary() {
  const latest = readEvidence('latest.json');
  const result = {};
  for (const key of Object.keys(suites)) {
    const item = readEvidence(`${key}.json`);
    result[key] = item ? {
      status: item.status || (item.results ? 'COMPLETED' : 'AVAILABLE'),
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      exitCode: item.exitCode,
      outputTail: item.output ? String(item.output).slice(-4000) : undefined,
    } : { status: 'NOT_RUN' };
  }
  return { latest, suites: result, files: evidenceFiles() };
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
  } finally {
    await pool.end().catch(() => {});
  }
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
  } finally {
    redis.disconnect();
  }
}

async function systemSnapshot() {
  const [backend, postgres, redis] = await Promise.all([backendHealth(), postgresSnapshot(), redisHealth()]);
  const evidence = evidenceSummary();
  return {
    timestamp: new Date().toISOString(),
    certification: {
      target: process.env.VAAYU_TEST_TARGET,
      backendUrl: BACKEND_URL,
      controlCenterPort: PORT,
      mode: 'read-only-observer',
    },
    backend,
    postgres,
    redis,
    suites,
    evidence,
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
    if (url.pathname.startsWith('/api/evidence/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/evidence/'.length));
      const item = readEvidence(name);
      return item ? json(res, 200, item) : json(res, 404, { error: 'Evidence not found' });
    }
    if (url.pathname === '/api/runs') return json(res, 200, evidenceSummary());
    if (url.pathname === '/api/suites') return json(res, 200, { suites });
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    return json(res, 500, { error: safeError(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[VAAYU CERT] Control Center listening on http://${HOST}:${PORT}`);
  console.log(`[VAAYU CERT] Observing backend ${BACKEND_URL}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
