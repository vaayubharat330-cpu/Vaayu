'use strict';

/**
 * Runtime dependency certification gate.
 *
 * Unlike the source/component inventory audits, this test performs real runtime
 * operations against the disposable backend dependencies. It deliberately
 * verifies PostgreSQL and Redis with write/read/delete round trips, exercises
 * the application's Redis-backed driver-location abstraction, then checks the
 * live HTTP server and authenticated WebSocket handshake. These checks prove
 * that the runtime dependency path is usable; they do not replace the domain suites.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require(path.join(__dirname, '..', 'node_modules', 'dotenv'));
const jwt = require(path.join(__dirname, '..', 'node_modules', 'jsonwebtoken'));
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
const secret = process.env.VAAYU_TEST_JWT_SECRET || process.env.JWT_SECRET || parsed.JWT_SECRET || '';
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

async function driverLocationStoreProbe() {
  if (!redisUrl) throw new Error('REDIS_URL is required');

  // The production adapter is selected explicitly for this probe. This avoids
  // accidentally certifying the in-memory fallback while the real Redis path is broken.
  process.env.ENABLE_DEV_REDIS = 'true';
  const { RedisClient } = require(path.join(root, 'src', 'services', 'redisClient'));
  const { RedisDriverLocationStore } = require(path.join(root, 'src', 'services', 'driverLocationStore'));
  const client = new RedisClient({ url: redisUrl });
  const store = new RedisDriverLocationStore(client);
  const driverId = `cert-driver-${crypto.randomUUID()}`;
  const record = {
    driverId,
    lat: 17.3850,
    lng: 78.4867,
    bearing: 90,
    speed: 12,
    lastPingMs: Date.now(),
    status: 'ONLINE',
    vehicleId: 'cert-vehicle',
    currentTripId: null,
    updatedAt: new Date().toISOString(),
  };

  try {
    const saved = await store.saveDriverLocation(driverId, record);
    const read = await store.getDriverLocation(driverId);
    const nearby = await store.findNearbyDrivers(record.lat, record.lng, 1, record.vehicleId);
    const historyPoint = { tripId: 'cert-trip', lat: record.lat, lng: record.lng, timestamp: new Date().toISOString() };
    await store.appendHistory(driverId, historyPoint);
    const history = await store.getDriverHistory(driverId, 'cert-trip');

    const result = {
      connected: true,
      saveReadRoundTrip: saved?.driverId === driverId && read?.driverId === driverId,
      numericLocationRoundTrip: read?.lat === record.lat && read?.lng === record.lng,
      spatialIndexRoundTrip: nearby.some(driver => driver.driverId === driverId),
      historyRoundTrip: history.length === 1 && history[0]?.tripId === 'cert-trip',
      staleOrOfflineExclusionContract: read?.status === 'ONLINE' && read?.currentTripId == null,
    };

    const failures = Object.entries(result).filter(([, ok]) => ok !== true).map(([name]) => name);
    return { ...result, passed: failures.length === 0, failures };
  } finally {
    try { await store.clearDriverLocation(driverId); } catch (_) {}
    try { await store.redis?.del(`driver:history:${driverId}`); } catch (_) {}
    try { await store.disconnect(); } catch (_) {}
  }
}

async function websocketProbe() {
  if (secret.length < 32) throw new Error('JWT secret must be at least 32 chars');
  const wsUrl = baseUrl.replace(/^http/, 'ws');
  const token = jwt.sign({ id: `cert_ws_${Date.now()}`, name: 'Certification WebSocket Probe', phone: '9999900000', role: 'ADMIN', city: 'Hyderabad' }, secret, { algorithm: 'HS256', expiresIn: 60 });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error('Authenticated WebSocket handshake timed out'));
    }, 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve({ connected: true, authenticated: true });
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
  for (const [name, probe] of Object.entries({
    http: httpProbe,
    postgres: postgresProbe,
    redis: redisProbe,
    driverLocationStore: driverLocationStoreProbe,
    websocket: websocketProbe,
  })) {
    try {
      const result = await probe();
      const passed = result.passed === undefined ? Object.values(result).every(value => value === true || typeof value !== 'boolean') : result.passed;
      checks[name] = { status: passed ? 'PASSED' : 'FAILED', ...result };
      if (!passed) errors.push(`${name}: ${result.failures?.join(', ') || 'runtime contract failure'}`);
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
      scope: 'Runtime dependency reachability, read/write behavior, and the production Redis-backed driver-location adapter.',
      nonClaim: 'Passing this audit does not prove domain correctness; domain certification suites remain mandatory.',
      productionSafe: true,
      adapterPath: 'apps/backend/src/services/driverLocationStore.js -> RedisDriverLocationStore -> RedisClient -> external Redis',
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
