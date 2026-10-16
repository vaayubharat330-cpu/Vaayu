'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CAMERA_FRAME_MIN_INTERVAL_MS,
  assertDriverOwnsSession,
  validateFrame,
  recordAcceptedFrame,
} = require('../../src/services/cameraSessionPolicy');

const session = (overrides = {}) => ({
  status: 'LIVE',
  driverId: 'driver-1',
  expiresAt: new Date(10_000).toISOString(),
  sequence: 4,
  ...overrides,
});

test('camera policy permits the owning driver', () => {
  assert.equal(assertDriverOwnsSession({ session: session(), user: { id: 'driver-1', role: 'DRIVER' } }).allowed, true);
});

test('camera policy blocks another driver from posting to the session', () => {
  const result = assertDriverOwnsSession({ session: session(), user: { id: 'driver-2', role: 'DRIVER' } });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'CAMERA_DRIVER_MISMATCH');
});

test('camera policy permits authorized non-driver viewers', () => {
  const result = assertDriverOwnsSession({ session: session(), user: { id: 'ops-1', role: 'DISPATCH_OPERATOR' } });
  assert.equal(result.allowed, true);
});

test('camera policy rejects expired sessions', () => {
  const result = validateFrame({ session: session({ expiresAt: new Date(5_000).toISOString() }), user: { id: 'driver-1', role: 'DRIVER' }, nowMs: 6_000, capturedAtMs: 6_000 });
  assert.equal(result.code, 'CAMERA_SESSION_EXPIRED');
});

test('camera policy rejects frame timestamps that go backwards', () => {
  const result = validateFrame({ session: session({ lastCapturedAtMs: 4_000 }), user: { id: 'driver-1', role: 'DRIVER' }, nowMs: 5_000, capturedAtMs: 3_900 });
  assert.equal(result.code, 'CAMERA_FRAME_TIME_REGRESSION');
});

test('camera policy enforces the snapshot frame interval', () => {
  const result = validateFrame({ session: session({ lastCapturedAtMs: 4_000 }), user: { id: 'driver-1', role: 'DRIVER' }, nowMs: 5_000, capturedAtMs: 4_000 + CAMERA_FRAME_MIN_INTERVAL_MS - 1 });
  assert.equal(result.code, 'CAMERA_FRAME_RATE_LIMITED');
});

test('accepted camera frame advances monotonic session metadata', () => {
  const current = session({ sequence: 4, lastCapturedAtMs: 4_000 });
  recordAcceptedFrame(current, { capturedAtMs: 5_000, sequence: 5 });
  assert.equal(current.sequence, 5);
  assert.equal(current.lastCapturedAtMs, 5_000);
  recordAcceptedFrame(current, { capturedAtMs: 4_500, sequence: 3 });
  assert.equal(current.sequence, 5);
  assert.equal(current.lastCapturedAtMs, 4_500);
});
