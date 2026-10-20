// Automated full test suite runner for VAAYU enterprise backend.
// This runner performs destructive operations (Redis rate-limit cleanup and PostgreSQL
// baseline restoration), so it refuses to run unless the caller explicitly identifies
// the target as disposable certification infrastructure.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envFile = path.resolve(__dirname, '..', '.env');
const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const jwtSecret = parsed.JWT_SECRET || process.env.JWT_SECRET || '';
const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000';
const databaseUrl = process.env.DATABASE_URL || parsed.DATABASE_URL || '';
const redisUrl = process.env.REDIS_URL || parsed.REDIS_URL || '';

function hostOf(value, label) {
  if (!value) throw new Error(`${label} is required for destructive certification.`);
  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  return parsedUrl.hostname;
}

function assertDisposableTarget() {
  if (process.env.VAAYU_TEST_TARGET !== 'disposable') {
    throw new Error('Refusing destructive certification: set VAAYU_TEST_TARGET=disposable.');
  }
  if (process.env.VAAYU_ALLOW_DESTRUCTIVE_TESTS !== 'true') {
    throw new Error('Refusing destructive certification: set VAAYU_ALLOW_DESTRUCTIVE_TESTS=true.');
  }

  const baseHost = hostOf(base, 'VAAYU_TEST_BASE');
  if (!['127.0.0.1', 'localhost', '::1'].includes(baseHost)) {
    throw new Error(`Refusing destructive certification against non-loopback base host: ${baseHost}`);
  }

  const dbHost = hostOf(databaseUrl, 'DATABASE_URL');
  if (!['127.0.0.1', 'localhost', '::1'].includes(dbHost)) {
    throw new Error(`Refusing destructive certification against non-loopback database host: ${dbHost}`);
  }

  if (redisUrl) {
    const redisHost = hostOf(redisUrl, 'REDIS_URL');
    if (!['127.0.0.1', 'localhost', '::1'].includes(redisHost)) {
      throw new Error(`Refusing destructive certification against non-loopback Redis host: ${redisHost}`);
    }
  }
}

const suites = [
  'test/unit/security.test.js',
  'test/unit/otp.test.js',
  'test/security/exposure.test.js',
  'test/security/authorization.test.js',
  'test/security/input.test.js',
  'test/security/transitions.test.js',
  'test/unit/no-silent-success.test.js',
  'test/integration/lifecycle.test.js',
  'test/integration/operations.test.js',
  'test/integration/websocket.test.js',
  'test/unit/postgresTransitionAtomicity.test.js',
  'test/unit/paymentIntegrationPostgresRouting.test.js',
  'test/unit/redisLockOwnership.test.js',
  'test/unit/telemetryReplaySuppression.test.js',
  'test/unit/dispatchCorrectnessConcurrency.test.js',
  'test/unit/realtimeStreamResilience.test.js',
  'test/unit/databaseDisasterRecoveryPolicy.test.js'
];

console.log('----------------------------------------------------');
console.log('VAAYU Enterprise Test Battery Runner');
console.log(`Base URL: ${base}`);
console.log(`JWT Secret: ${jwtSecret ? 'Loaded (' + jwtSecret.length + ' chars)' : 'MISSING'}`);
console.log(`Target: ${process.env.VAAYU_TEST_TARGET || 'UNSPECIFIED'}`);
console.log(`Suites: ${suites.length}`);
console.log('----------------------------------------------------\n');

(async () => {
  try {
    assertDisposableTarget();
  } catch (error) {
    console.error(`\nCERTIFICATION ABORTED: ${error.message}`);
    process.exit(2);
  }

  if (redisUrl) {
    try {
      const Redis = require('ioredis');
      const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
      const keys = await redis.keys('rate:limiter:*');
      if (keys.length) await redis.del(keys);
      await redis.quit();
    } catch (e) {
      console.error(`Redis reset failed: ${e.message}`);
      process.exit(2);
    }
  }

  let failed = 0;
  for (const suite of suites) {
    process.stdout.write(`Running ${suite} ... `);
    try {
      execSync(`node ${suite}`, {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, VAAYU_TEST_JWT_SECRET: jwtSecret, VAAYU_TEST_BASE: base },
        stdio: 'pipe'
      });
      console.log('PASSED ✓');
    } catch (err) {
      console.log('FAILED ✗');
      console.error(err.stdout ? err.stdout.toString() : err.message);
      failed++;
    }
  }

  console.log('\n----------------------------------------------------');
  if (failed === 0) {
    console.log(`ALL ${suites.length} TEST SUITES PASSED ✓`);
    try {
      execSync('node src/db/seedPostgres.js --force', { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
      console.log('Disposable Postgres clean baseline restored.');
    } catch (e) {
      console.error(`Postgres baseline restore failed: ${e.message}`);
      process.exit(2);
    }
    process.exit(0);
  }

  console.error(`${failed}/${suites.length} SUITES FAILED ✗`);
  process.exit(1);
})();
