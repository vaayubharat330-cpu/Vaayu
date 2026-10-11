// Unit tests for OTP hashing and the secret requirement. No server or network is needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const backend = path.join(__dirname, '..', '..');
process.env.OTP_HASH_SECRET = 'unit-test-otp-pepper-that-is-at-least-32-chars!';
process.env.JWT_SECRET = 'unit-test-secret-that-is-at-least-32-chars-long!';

const { OtpService } = require(path.join(backend, 'src', 'services', 'otpService'));

test('OTP digest is deterministic for the same phone and code', () => {
  const svc = new OtpService();
  assert.equal(svc.digest('+919999999999', '123456'), svc.digest('+919999999999', '123456'));
});

test('OTP digest differs for a different code or phone', () => {
  const svc = new OtpService();
  assert.notEqual(svc.digest('+919999999999', '123456'), svc.digest('+919999999999', '654321'));
  assert.notEqual(svc.digest('+919999999999', '123456'), svc.digest('+918888888888', '123456'));
});

test('OTP digest refuses to run without a dedicated OTP_HASH_SECRET', () => {
  const saved = process.env.OTP_HASH_SECRET;
  delete process.env.OTP_HASH_SECRET;
  try {
    assert.throws(() => new OtpService().digest('+919999999999', '123456'), /OTP_HASH_SECRET/);
  } finally {
    process.env.OTP_HASH_SECRET = saved;
  }
});

test('OTP digest does not depend on JWT_SECRET', () => {
  const svc = new OtpService();
  const before = svc.digest('+919999999999', '123456');
  const savedJwt = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'a-completely-different-jwt-secret-value-here-32+';
  try {
    assert.equal(svc.digest('+919999999999', '123456'), before);
  } finally {
    process.env.JWT_SECRET = savedJwt;
  }
});
