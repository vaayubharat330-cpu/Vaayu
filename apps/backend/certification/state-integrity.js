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
const Redis = require('ioredis');
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
    socket.once('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'));
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function redisDriverSpatialIntegrity() {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
  });

  try {
    await redis.connect();
    const driverIds = await redis.zrange('drivers:active:spatial', 0, -1);
    const orphanedSpatialMembers = [];
    const malformedLocations = [];
    const activeLocations = [];

    for (const driverId of driverIds) {
      const location = await redis.hgetall(`driver:loc:${driverId}`);
      if (!location || Object.keys(location).length === 0) {
        orphanedSpatialMembers.push(driverId);
        continue;
      }

      const latitude = Number(location.latitude);
      const longitude = Number(location.longitude);
      const lastPingMs = Number(location.lastPingMs);
      const validCoordinates = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
        && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
      const validTimestamp = Number.isFinite(lastPingMs) && lastPingMs > 0;

      if (!validCoordinates || !validTimestamp) {
        malformedLocations.push({ driverId, fields: Object.keys(location) });
        continue;
      }

      activeLocations.push({
        driverId,
        latitude,
        longitude,
        online: String(location.online) === 'true',
        currentTripId: location.currentTripId || null,
        lastPingMs,
      });
    }

    return {
      ok: orphanedSpatialMembers.length === 0 && malformedLocations.length === 0,
      spatialMembers: driverIds.length,
      validLocations: activeLocations.length,
      orphanedSpatialMembers,
      malformedLocations,
      activeLocations,
      policy: 'Every Redis active-driver spatial member must have a valid driver location hash and valid coordinates/timestamp.'
    };
  } finally {
    redis.disconnect();
  }
}

async function main() {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for state integrity certification.');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const redis = await redisPing(redisUrl);
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const checks = [];
  let redisSpatial = { ok: false, error: 'not executed' };
  try {
    const health = await pool.query('SELECT 1 AS ok');
    checks.push({ name: 'postgres-connectivity', ok: health.rows[0]?.ok === 1 });

    const allRecords = await pool.query(
      'SELECT collection, record_key, data FROM vaayu_records ORDER BY created_at DESC'
    );

    let malformedRecords = 0;
    let missingRecordKeys = 0;
    let invalidRecordKeyFormat = 0;
    let mismatchedRecordIdentity = 0;
    const seenRecordKeys = new Set();
    let duplicateRecordKeys = 0;

    for (const row of allRecords.rows) {
      const data = row.data;
      if (!row.record_key || typeof row.record_key !== 'string') {
        missingRecordKeys++;
      } else {
        if (seenRecordKeys.has(row.record_key)) duplicateRecordKeys++;
        seenRecordKeys.add(row.record_key);
        if (!/^id:.+/.test(row.record_key)) invalidRecordKeyFormat++;
      }

      if (!isPlainObject(data)) {
        malformedRecords++;
        continue;
      }

      if (data.id !== undefined && row.record_key !== `id:${data.id}`) {
        mismatchedRecordIdentity++;
      }
    }

    checks.push({ name: 'persisted-record-shape', ok: malformedRecords === 0, failures: malformedRecords });
    checks.push({ name: 'persisted-record-key-presence', ok: missingRecordKeys === 0, failures: missingRecordKeys });
    checks.push({ name: 'persisted-record-key-format', ok: invalidRecordKeyFormat === 0, failures: invalidRecordKeyFormat });
    checks.push({ name: 'persisted-record-identity', ok: mismatchedRecordIdentity === 0, failures: mismatchedRecordIdentity });
    checks.push({ name: 'persisted-record-key-uniqueness', ok: duplicateRecordKeys === 0, failures: duplicateRecordKeys });

    const trips = await pool.query(
      "SELECT record_key, data FROM vaayu_records WHERE collection='trips' ORDER BY created_at DESC"
    );

    const trackingTokens = new Map();
    let malformed = 0;
    let missingIdentity = 0;
    let missingVersion = 0;
    let duplicateTrackingTokens = 0;

    for (const row of trips.rows) {
      const data = row.data || {};
      const expectedKey = `id:${data.id}`;
      if (!data.id || row.record_key !== expectedKey) missingIdentity++;
      if (data.version !== undefined && (!Number.isInteger(data.version) || data.version < 1)) missingVersion++;
      if (data.version === undefined && data.status) missingVersion++;
      if (data.status && typeof data.status !== 'string') malformed++;

      if (data.trackingToken) {
        const prior = trackingTokens.get(data.trackingToken);
        if (prior && prior !== data.id) duplicateTrackingTokens++;
        trackingTokens.set(data.trackingToken, data.id);
      }
    }

    checks.push({ name: 'trip-record-identity', ok: missingIdentity === 0, failures: missingIdentity });
    checks.push({ name: 'trip-version-integrity', ok: missingVersion === 0, failures: missingVersion });
    checks.push({ name: 'trip-structure', ok: malformed === 0, failures: malformed });
    checks.push({ name: 'tracking-token-uniqueness', ok: duplicateTrackingTokens === 0, failures: duplicateTrackingTokens });
    checks.push({ name: 'redis-connectivity', ...redis });

    redisSpatial = await redisDriverSpatialIntegrity();
    checks.push({
      name: 'redis-driver-spatial-integrity',
      ok: redisSpatial.ok,
      failures: redisSpatial.orphanedSpatialMembers.length + redisSpatial.malformedLocations.length,
      spatialMembers: redisSpatial.spatialMembers,
      validLocations: redisSpatial.validLocations,
    });

    const result = {
      generatedAt: new Date().toISOString(),
      target: process.env.VAAYU_TEST_TARGET,
      databaseUrl: databaseUrl.replace(/:\/\/[^@]+@/, '://***@'),
      redisUrl,
      totalPersistedRecords: allRecords.rows.length,
      tripRecords: trips.rows.length,
      checks,
      redisDriverSpatial: redisSpatial,
      passed: checks.filter(c => c.ok).length,
      failed: checks.filter(c => !c.ok).length,
      policy: 'Structural persistence and Redis state integrity only; behavioural correctness must be proven by E2E and runtime component suites.'
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
