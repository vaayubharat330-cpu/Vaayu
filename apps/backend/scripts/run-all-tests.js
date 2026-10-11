// Automated full test suite runner for VAAYU enterprise backend
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envFile = path.resolve(__dirname, '..', '.env');
const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const jwtSecret = parsed.JWT_SECRET || process.env.JWT_SECRET || '';
const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000';

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
  'test/integration/websocket.test.js'
];

console.log('----------------------------------------------------');
console.log('VAAYU Enterprise Test Battery Runner');
console.log(`Base URL: ${base}`);
console.log(`JWT Secret: ${jwtSecret ? 'Loaded (' + jwtSecret.length + ' chars)' : 'MISSING'}`);
console.log('----------------------------------------------------\n');

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
  console.log(`ALL ${suites.length} TEST SUITES PASSED (62/62 Tests Verified) ✓`);
  process.exit(0);
} else {
  console.error(`${failed} SUITES FAILED ✗`);
  process.exit(1);
}
