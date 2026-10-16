'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CameraFrameGateway } = require('../../src/services/cameraFrameGateway');

const jpegData = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64')}`;
function session() {
  return { id: 'cam-1', status: 'LIVE', driverId: 'driver-1', sequence: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

test('gateway validates a valid owned frame without mutating the cursor', async () => {
  const s = session();
  const gateway = new CameraFrameGateway({ acquireRateSlot: async () => true });
  const result = await gateway.accept({
    session: s,
    user: { id: 'driver-1', role: 'DRIVER' },
    imageData: jpegData,
    sequence: 1,
    capturedAt: new Date().toISOString(),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.sequence, 1);
  assert.equal(s.sequence, 0);
  assert.equal(result.sha256.length, 64);

  const committed = gateway.commitAcceptedFrame(s, { sequence: result.sequence, capturedAtMs: result.capturedAtMs });
  assert.equal(committed.allowed, true);
  assert.equal(s.sequence, 1);
});

test('gateway rejects another driver and does not mutate session', async () => {
  const s = session();
  const gateway = new CameraFrameGateway({ acquireRateSlot: async () => true });
  const result = await gateway.accept({ session: s, user: { id: 'driver-2', role: 'DRIVER' }, imageData: jpegData, sequence: 1 });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'CAMERA_DRIVER_MISMATCH');
  assert.equal(s.sequence, 0);
});

test('gateway rejects sequence replay and rate-slot denial', async () => {
  const s = session();
  s.sequence = 1;
  const replay = new CameraFrameGateway({ acquireRateSlot: async () => true });
  const replayResult = await replay.accept({ session: s, user: { id: 'driver-1', role: 'DRIVER' }, imageData: jpegData, sequence: 1 });
  assert.equal(replayResult.code, 'CAMERA_SEQUENCE_INVALID');

  const limited = new CameraFrameGateway({ acquireRateSlot: async () => false });
  const limitedResult = await limited.accept({ session: session(), user: { id: 'driver-1', role: 'DRIVER' }, imageData: jpegData, sequence: 1 });
  assert.equal(limitedResult.code, 'CAMERA_FRAME_RATE_LIMITED');
});

test('gateway commit rejects duplicate acceptance after another request wins the cursor', async () => {
  const s = session();
  const gateway = new CameraFrameGateway({ acquireRateSlot: async () => true });
  const capturedAt = new Date().toISOString();
  const first = await gateway.accept({ session: s, user: { id: 'driver-1', role: 'DRIVER' }, imageData: jpegData, sequence: 1, capturedAt });
  const second = await gateway.accept({ session: s, user: { id: 'driver-1', role: 'DRIVER' }, imageData: jpegData, sequence: 1, capturedAt });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(gateway.commitAcceptedFrame(s, { sequence: first.sequence, capturedAtMs: first.capturedAtMs }).allowed, true);
  const loser = gateway.commitAcceptedFrame(s, { sequence: second.sequence, capturedAtMs: second.capturedAtMs });
  assert.equal(loser.allowed, false);
  assert.equal(loser.code, 'CAMERA_FRAME_STATE_CONFLICT');
  assert.equal(s.sequence, 1);
});
