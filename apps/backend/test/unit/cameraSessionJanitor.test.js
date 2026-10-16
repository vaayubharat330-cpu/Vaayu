'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CameraSessionJanitor } = require('../../src/services/cameraSessionJanitor');

test('janitor expires stale sessions and removes their ephemeral frame', async () => {
  const store = {
    camera_stream_sessions: [
      {
        id: 'cam-expired',
        status: 'LIVE',
        expiresAt: '2026-10-16T09:59:00.000Z',
        latestFrameRef: '/redis-camera-streams/frame.jpg',
        latestFrameSha256: 'abc',
      },
      {
        id: 'cam-live',
        status: 'LIVE',
        expiresAt: '2026-10-16T11:00:00.000Z',
      },
    ],
  };
  const deleted = [];
  let saved = 0;
  const db = {
    getDb: () => store,
    saveDb: () => { saved += 1; },
    waitForCommit: async () => {},
  };
  const redis = { del: async key => deleted.push(key) };
  const janitor = new CameraSessionJanitor({
    db,
    redisClient: redis,
    now: () => Date.parse('2026-10-16T10:00:00.000Z'),
  });

  const result = await janitor.reap();

  assert.equal(result.reaped, 1);
  assert.equal(store.camera_stream_sessions[0].status, 'EXPIRED');
  assert.equal(store.camera_stream_sessions[0].latestFrameRef, null);
  assert.equal(store.camera_stream_sessions[0].latestFrameSha256, null);
  assert.deepEqual(deleted, ['vaayu:camera:frame:cam-expired']);
  assert.equal(saved, 1);
  assert.equal(store.camera_stream_sessions[1].status, 'LIVE');
});

test('janitor fails closed on malformed expiry timestamps', async () => {
  const store = { camera_stream_sessions: [{ id: 'cam-invalid', status: 'LIVE', expiresAt: 'not-a-date' }] };
  let deleted = 0;
  const janitor = new CameraSessionJanitor({
    db: { getDb: () => store, saveDb: () => {} },
    redisClient: { del: async () => { deleted += 1; } },
    now: () => Date.now(),
  });

  const result = await janitor.reap();

  assert.equal(result.reaped, 1);
  assert.equal(store.camera_stream_sessions[0].status, 'EXPIRED');
  assert.equal(deleted, 1);
});

test('janitor does not overlap concurrent reaps', async () => {
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const store = { camera_stream_sessions: [] };
  const janitor = new CameraSessionJanitor({
    db: {
      getDb: () => store,
      saveDb: () => {},
      waitForCommit: async () => blocker,
    },
  });

  const first = janitor.reap();
  const second = await janitor.reap();
  assert.deepEqual(second, { reaped: 0 });
  release();
  assert.deepEqual(await first, { reaped: 0 });
});
