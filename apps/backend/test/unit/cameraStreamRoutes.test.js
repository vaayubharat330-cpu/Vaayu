const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProofRoutes } = require('../../src/http/proofRoutes');
const { redisPubSub } = require('../../src/services/redisPubSub');

const ONE_PIXEL_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEABj8Cf//Z';

function makeReq(body, user = { id: 'user_driver_1', role: 'DRIVER' }) {
  const req = new EventEmitter();
  req.user = user;
  req.headers = {};
  req.emitBody = () => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); };
  return req;
}

function makeRes() {
  return { statusCode: null, headers: {}, body: Buffer.alloc(0), writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; }, end(payload = '') { this.body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)); if (this.resolve) this.resolve(); } };
}
function responsePromise(res) { return new Promise(resolve => { res.resolve = resolve; }); }
function makeDb() {
  const store = { camera_stream_sessions: [] };
  return { getDb: () => store, saveDb: () => {}, getTrips: () => [{ id: 'trip_1', driver: { id: 'driver_1', userId: 'user_driver_1' } }], getDrivers: () => [{ id: 'driver_1', userId: 'user_driver_1' }] };
}

async function invoke(handler, req, res, route) {
  const pending = responsePromise(res);
  const task = handler(req, res, route);
  req.emitBody();
  await task;
  await pending;
}

function installRedisMap() {
  const redis = new Map();
  const original = { set: redisPubSub.pubClient.set, get: redisPubSub.pubClient.get, del: redisPubSub.pubClient.del };
  redisPubSub.pubClient.set = async (key, value) => { redis.set(key, String(value)); return 'OK'; };
  redisPubSub.pubClient.get = async key => redis.get(key) || null;
  redisPubSub.pubClient.del = async key => { redis.delete(key); return 1; };
  return { redis, restore() { redisPubSub.pubClient.set = original.set; redisPubSub.pubClient.get = original.get; redisPubSub.pubClient.del = original.del; } };
}

test('live camera route: start -> frame -> read -> stop', async () => {
  const db = makeDb();
  const { redis, restore } = installRedisMap();
  try {
    const handler = createProofRoutes({ db, enforceDriverAccess: async () => true, enforceSecurityChecks: async () => true });
    const startReq = makeReq({ trip_id: 'trip_1' });
    const startRes = makeRes();
    await invoke(handler, startReq, startRes, { pathname: '/api/trip/camera/session/start', parsedUrl: { query: {} } });
    assert.equal(startRes.statusCode, 201);
    const start = JSON.parse(startRes.body.toString());
    assert.ok(start.sessionId);

    const frameReq = makeReq({ session_id: start.sessionId, image_data: `data:image/jpeg;base64,${ONE_PIXEL_JPEG}` });
    const frameRes = makeRes();
    await invoke(handler, frameReq, frameRes, { pathname: '/api/trip/camera/frame', parsedUrl: { query: {} } });
    assert.equal(frameRes.statusCode, 200);
    assert.equal(JSON.parse(frameRes.body.toString()).sequence, 1);

    const getReq = makeReq(undefined);
    const getRes = makeRes();
    await invoke(handler, getReq, getRes, { pathname: '/api/trip/camera/frame', parsedUrl: { query: { session_id: start.sessionId } } });
    assert.equal(getRes.statusCode, 200);
    assert.ok(getRes.body.length > 10);
    assert.equal(getRes.headers['Content-Type'], 'image/jpeg');

    const stopReq = makeReq({ session_id: start.sessionId });
    const stopRes = makeRes();
    await invoke(handler, stopReq, stopRes, { pathname: '/api/trip/camera/session/stop', parsedUrl: { query: {} } });
    assert.equal(stopRes.statusCode, 200);
    assert.equal(redis.size, 0);
  } finally {
    restore();
  }
});

test('live camera route rejects tampered Redis frame instead of serving it', async () => {
  const db = makeDb();
  const { redis, restore } = installRedisMap();
  try {
    const handler = createProofRoutes({ db, enforceDriverAccess: async () => true, enforceSecurityChecks: async () => true });
    const startReq = makeReq({ trip_id: 'trip_1' });
    const startRes = makeRes();
    await invoke(handler, startReq, startRes, { pathname: '/api/trip/camera/session/start', parsedUrl: { query: {} } });
    const sessionId = JSON.parse(startRes.body.toString()).sessionId;

    const frameReq = makeReq({ session_id: sessionId, image_data: `data:image/jpeg;base64,${ONE_PIXEL_JPEG}` });
    const frameRes = makeRes();
    await invoke(handler, frameReq, frameRes, { pathname: '/api/trip/camera/frame', parsedUrl: { query: {} } });
    assert.equal(frameRes.statusCode, 200);

    const key = `vaayu:camera:frame:${sessionId}`;
    const stored = JSON.parse(redis.get(key));
    const bytes = Buffer.from(stored.data, 'base64');
    bytes[bytes.length - 1] ^= 0xff;
    stored.data = bytes.toString('base64');
    redis.set(key, JSON.stringify(stored));

    const getReq = makeReq(undefined);
    const getRes = makeRes();
    await invoke(handler, getReq, getRes, { pathname: '/api/trip/camera/frame', parsedUrl: { query: { session_id: sessionId } } });
    assert.equal(getRes.statusCode, 500);
    const error = JSON.parse(getRes.body.toString());
    assert.equal(error.error, 'Live camera frame failed integrity verification.');
    assert.equal(error.code, 'CAMERA_FRAME_INTEGRITY_MISMATCH');
    assert.equal(getRes.body.length > 0, true);
  } finally {
    restore();
  }
});