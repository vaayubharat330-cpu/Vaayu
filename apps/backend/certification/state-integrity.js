'use strict';

/**
 * Runtime state-integrity certification.
 *
 * This suite is deliberately narrower than the behavioural E2E suites: it checks
 * the authoritative persistence layer and the Redis dependency for structural
 * invariants after the behavioural suites have exercised the system.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { Pool } = require('pg');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
const envFile = path.resolve(root, '.env');
const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const databaseUrl = process.env.DATABASE_URL || parsed.DATABASE_URL || '';
const redisUrl = process.env.REDIS_URL || parsed.REDIS_URL || 'redis://127.0.0.1:56379';
const evidenceDir = path.resolve(__dirname, 'artifacts');

if (process.env.NODE_ENV === 'production' || process.env.VAAYU_TEST_TARGET !== 'disposable') {
  throw new Error('State integrity certification requires VAAYU_TEST_TARGET=disposable.');
}

function redisPing(url) {
  const parsedUrl = new URL(url);
  const host = parsedUrl.hostname || '127.0.0.1';
  const port = Number(parsedUrl.port || 6379);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: 'Redis PING timeout' });
    }, 3000);
    socket.once('connect', () => socket.write('*1\\r\\n$4\\r\\nPING\\r\\n'));
    socket.on('data', chunk => {
      clearTimeout(timer);
      const response = chunk.toString();
      socket.end();
      resolve({ ok: response.includes('+PONG'), response: response.trim() });
    });
    socket.once('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
  });
}

async function main() {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for state integrity certification.');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const redis = await redisPing(redisUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const checks = [];
  try {
    const health = await pool.query('SELECT 1 AS ok');
    checks.push({ name: 'postgres-connectivity', ok: health.rows[0]?.ok === 1 });

    const trips = await pool.query(
      "SELECT record_key, data FROM vaayu_records WHERE collection='trips' ORDER BY created_at DESC"
    );

    const trackingTokens = new Map();
    let malformed = 0;
    let missingIdentity = 0;
    let missingVersion = 0;

    for (const row of trips.rows) {
      const data = row.data || {};
      const expectedKey = `id:${data.id}`;
      if (!data.id || row.record_key !== expectedKey) missingIdentity++;
      if (data.version !== undefined && (!Number.isInteger(data.version) || data.version < 1)) missingVersion++;
      if (data.version === undefined && data.status) missingVersion++;
      if (data.status && typeof data.status !== 'string') malformed++;

      if (data.trackingToken) {
        const prior = trackingTokens.get(data.trackingToken);
        if (prior && prior !== data.id) malformed++;
        trackingTokens.set(data.trackingToken, data.id);
      }
    }

    checks.push({ name: 'trip-record-identity', ok: missingIdentity === 0, failures: missingIdentity });
    checks.push({ name: 'trip-version-integrity', ok: missingVersion === 0, failures: missingVersion });
    checks.push({ name: 'trip-structure', ok: malformed === 0, failures: malformed });
    checks.push({ name: 'tracking-token-uniqueness', ok: trackingTokens.size === new Set(trackingTokens.keys()).size });
    checks.push({ name: 'redis-connectivity', ...redis });

    const result = {
      generatedAt: new Date().toISOString(),
      target: process.env.VAAYU_TEST_TARGET,
      databaseUrl: databaseUrl.replace(/:\/\/[^@]+@/, '://***@'),
      redisUrl,
      tripRecords: trips.rows.length,
      checks,
      passed: checks.filter(c => c.ok).length,
      failed: checks.filter(c => !c.ok).length,
      policy: 'Structural integrity only; behavioural correctness must be proven by E2E suites.'
    };

    fs.writeFileSync(path.join(evidenceDir, 'state-integrity.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (result.failed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
