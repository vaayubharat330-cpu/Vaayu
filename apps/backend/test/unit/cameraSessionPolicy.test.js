'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CAMERA_FRAME_MIN_INTERVAL_MS, assertDriverOwnsSession, validateFrame, recordAcceptedFrame } = require('../../src/services/cameraSessionPolicy');

const session = (overrides = {}) => ({ status: 'LIVE', driverId: 'driver-1', expiresAt: new Date(10_000).toISOString(), sequence: 4, ...overrides });

test('camera policy permits the owning driver', () => assert.equal(assertDriverOwnsSession({ session: session(), user: { id: 'driver-1', role: 'DRIVER' } }).allowed, true));
test('camera policy blocks another driver from posting to the session', () => {
  const result = assertDriverOwnsSession({ session: session(), user: { id: 'driver-2', role: 'DRIVER' } });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'CAMERA_DRIVER_MISMATCH');
});
test('camera policy permits authorized non-driver viewers', () => assert.equal(assertDriverOwnsSession({ session: session(), user: { id: 'ops-1', role: 'DISPATCH_OPERATOR' } }).allowed, true));
test('camera policy rejects expired sessions', () => assert.equal(validateFrame({ session: session({ expiresAt: new Date(5_000).toISOString() }), user: { id: 'driver-1', role: 'DRIVER' }, nowMs: 6_000, capturedAtMs: 6_000 }).code, 'CAMERA_SESSION_EXPIRED'));
test('camera policy rejects frame timestamps that go backwards', () => assert.equal(validateFrame({ session: session({ lastCapturedAtMs: 4_000 }), user: { id: 'driver-1', role: 'DRIVER' }, nowMs: 5_000, capturedAtMs: 3_900 }).code, 'CAMERA_FRAME_TIME_REGRESSION'));
test('camera policy enforces the snapshot frame interval', () => assert.equal(validateFrame({ session: session({ lastCapturedAtMs: 4_000 }), user: { id: 'driver-1', role: 'DRIVER' }, nowMs: 5_000, capturedAtMs: 4_000 + CAMERA_FRAME_MIN_INTERVAL_MS - 1 }).code, 'CAMERA_FRAME_RATE_LIMITED'));
test('accepted camera frame metadata remains monotonic', () => {
  const current = session({ sequence: 4, lastCapturedAtMs: 4_000 });
  assert.equal(recordAcceptedFrame(current, { capturedAtMs: 5_000, sequence: 5 }), true);
  assert.equal(current.sequence, 5);
  assert.equal(current.lastCapturedAtMs, 5_000);
  assert.equal(recordAcceptedFrame(current, { capturedAtMs: 4_500, sequence: 3 }), false);
  assert.equal(current.sequence, 5);
  assert.equal(current.lastCapturedAtMs, 5_000);
});
test('commit-time sequence check rejects a duplicate concurrent frame', () => {
  const current = session({ sequence: 8, lastCapturedAtMs: 8_000 });
  assert.equal(recordAcceptedFrame(current, { capturedAtMs: 9_000, sequence: 9 }), true);
  assert.equal(recordAcceptedFrame(current, { capturedAtMs: 9_100, sequence: 9 }), false);
  assert.equal(current.sequence, 9);
});
test('commit-time sequence check rejects a skipped frame', () => {
  const current = session({ sequence: 8, lastCapturedAtMs: 8_000 });
  assert.equal(recordAcceptedFrame(current, { capturedAtMs: 10_000, sequence: 10 }), false);
  assert.equal(current.sequence, 8);
  assert.equal(current.lastCapturedAtMs, 8_000);
});
