// Unit tests for the security-critical code paths. No server, database, or network is needed.
// Run with: npm test  (uses the Node built-in test runner)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const backend = path.join(__dirname, '..', '..');
const SECRET = 'unit-test-secret-that-is-at-least-32-chars-long!';
process.env.JWT_SECRET = SECRET;
process.env.OTP_HASH_SECRET = 'unit-test-otp-pepper-that-is-at-least-32-chars!';

const jwt = require(path.join(backend, 'node_modules', 'jsonwebtoken'));
const { AuthService } = require(path.join(backend, 'src', 'services', 'authService'));

test('signs and verifies a token with the configured secret', () => {
  const auth = new AuthService();
  const token = auth.generateToken({ id: 'u1', role: 'CUSTOMER' }, 60000);
  const payload = auth.verifyToken(token);
  assert.ok(payload);
  assert.equal(payload.id, 'u1');
});

test('refuses to sign when the secret is missing or short', () => {
  const saved = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    assert.throws(() => new AuthService().getSecret(), /at least 32 characters/);
  } finally {
    process.env.JWT_SECRET = saved;
  }
  assert.throws(() => new AuthService('short').getSecret(), /at least 32 characters/);
});

test('rejects a token signed with the old public development secret', () => {
  const auth = new AuthService();
  const forged = jwt.sign({ id: 'x', role: 'SUPER_ADMIN' }, 'vaayu_jwt_secret_development_key_1234567890_!@#$%');
  assert.equal(auth.verifyToken(forged), null);
});

test('rejects tokens that use an algorithm other than HS256', () => {
  const auth = new AuthService();
  const hs512 = jwt.sign({ id: 'x', role: 'SUPER_ADMIN' }, SECRET, { algorithm: 'HS512' });
  const none = jwt.sign({ id: 'x', role: 'SUPER_ADMIN' }, '', { algorithm: 'none' });
  assert.equal(auth.verifyToken(hs512), null);
  assert.equal(auth.verifyToken(none), null);
});

test('reads the bearer token from the header only', () => {
  const auth = new AuthService();
  assert.equal(auth.extractToken({ url: '/api/x', headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(auth.extractToken({ url: '/api/x?token=abc', headers: {} }), null);
});

test('expired tokens are rejected', () => {
  const auth = new AuthService();
  const expired = jwt.sign({ id: 'x', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET, { algorithm: 'HS256' });
  assert.equal(auth.verifyToken(expired), null);
});
