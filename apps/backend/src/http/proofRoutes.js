// Proof-of-delivery photos and authenticated live camera snapshot sessions.
// KYC/POD files remain private on disk; live camera frames are ephemeral and shared through Redis.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redisPubSub } = require('../services/redisPubSub');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const PRIVATE_PROOF_PHOTOS = path.resolve(BACKEND_ROOT, 'private_uploads', 'proof_photos');
const PRIVATE_CAMERA_STREAMS = path.resolve(BACKEND_ROOT, 'private_uploads', 'camera_streams');
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 7.5 * 1024 * 1024;
const MAX_CAMERA_FRAME_BYTES = 750 * 1024;
const CAMERA_SESSION_TTL_MS = 30 * 60 * 1000;
const CAMERA_REDIS_PREFIX = 'vaayu:camera:frame:';

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  return res.end(JSON.stringify(payload));
}

function parseImage(data, maxBytes) {
  if (typeof data !== 'string') return null;
  const match = data.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxBytes) return null;
  return { format: match[1], bytes };
}

function readJsonBody(req, maxBytes = MAX_REQUEST_BYTES) {
  return new Promise(resolve => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => { size += chunk.length; if (size > maxBytes) { tooLarge = true; return; } body += chunk; });
    req.on('end', () => {
      if (tooLarge) return resolve({ error: 'PAYLOAD_TOO_LARGE' });
      try { resolve({ data: JSON.parse(body) }); } catch (_) { resolve({ error: 'INVALID_JSON' }); }
    });
    req.on('error', () => resolve({ error: 'REQUEST_READ_FAILED' }));
  });
}

function getCameraSessions(db) {
  const store = db.getDb ? db.getDb() : {};
  if (!Array.isArray(store.camera_stream_sessions)) store.camera_stream_sessions = [];
  return store.camera_stream_sessions;
}

function getSession(db, sessionId) { return getCameraSessions(db).find(s => s.id === sessionId) || null; }
function frameKey(sessionId) { return `${CAMERA_REDIS_PREFIX}${sessionId}`; }

function cleanupOldFrameFile(ref) {
  if (!ref) return;
  const file = path.resolve(PRIVATE_CAMERA_STREAMS, path.basename(ref));
  if (file.startsWith(PRIVATE_CAMERA_STREAMS + path.sep)) { try { fs.unlinkSync(file); } catch (_) {} }
}

function createProofRoutes({ db, enforceDriverAccess, enforceSecurityChecks }) {
  return async function handleProofRoute(req, res, { pathname, parsedUrl }) {
    if (pathname === '/api/trip/camera/session/start' && req.method === 'POST') {
      const parsed = await readJsonBody(req);
      if (parsed.error) return json(res, parsed.error === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { success: false, error: parsed.error });
      const data = parsed.data || {};
      const tripId = typeof data.trip_id === 'string' ? data.trip_id : '';
      if (!tripId || !await enforceSecurityChecks(req, res, { requiredRoles: ['DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'], targetOrderId: tripId })) return true;
      const trip = (db.getTrips ? db.getTrips() : []).find(t => t.id === tripId);
      if (!trip) return json(res, 404, { success: false, error: 'Trip not found.' });
      const driver = (db.getDrivers ? db.getDrivers() : []).find(d => d.userId === req.user.id || d.id === req.user.id || d.id === trip.driver?.id || d.userId === trip.driver?.userId);
      if (req.user.role === 'DRIVER' && (!driver || String(trip.driver?.id || trip.driver?.userId) !== String(driver.id || driver.userId))) return json(res, 403, { success: false, error: 'Camera session is not assigned to this driver.' });
      const sessions = getCameraSessions(db);
      const now = Date.now();
      for (const session of sessions) {
        if (session.tripId === tripId && session.status === 'LIVE' && now - Date.parse(session.updatedAt || session.createdAt) < CAMERA_SESSION_TTL_MS) return json(res, 200, { success: true, sessionId: session.id, reused: true, expiresAt: session.expiresAt });
      }
      const sessionId = `cam_${crypto.randomBytes(16).toString('hex')}`;
      const session = { id: sessionId, tripId, driverId: driver?.id || req.user.id, status: 'LIVE', sequence: 0, latestFrameRef: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(now + CAMERA_SESSION_TTL_MS).toISOString() };
      sessions.push(session);
      if (typeof db.saveDb === 'function') db.saveDb();
      return json(res, 201, { success: true, sessionId, expiresAt: session.expiresAt });
    }

    if (pathname === '/api/trip/camera/frame' && req.method === 'POST') {
      const parsed = await readJsonBody(req, 1024 * 1024);
      if (parsed.error) return json(res, parsed.error === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { success: false, error: parsed.error });
      const data = parsed.data || {};
      const sessionId = typeof data.session_id === 'string' ? data.session_id : '';
      const session = getSession(db, sessionId);
      if (!session || session.status !== 'LIVE' || Date.now() > Date.parse(session.expiresAt)) return json(res, 410, { success: false, error: 'Camera session expired.' });
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'], targetOrderId: session.tripId })) return true;
      const image = parseImage(data.image_data, MAX_CAMERA_FRAME_BYTES);
      if (!image) return json(res, 413, { success: false, error: 'Camera frame must be JPEG, PNG, or WebP and <= 750 KB.' });

      const nextSequence = Number(session.sequence || 0) + 1;
      const capturedAt = new Date().toISOString();
      const previousRef = session.latestFrameRef;
      const extension = image.format === 'jpeg' ? 'jpg' : image.format;
      const filename = `frame_${crypto.randomBytes(16).toString('hex')}.${extension}`;
      const redisValue = JSON.stringify({ sequence: nextSequence, capturedAt, format: image.format, data: image.bytes.toString('base64') });
      await redisPubSub.pubClient.set(frameKey(sessionId), redisValue, 'PX', CAMERA_SESSION_TTL_MS);
      session.sequence = nextSequence;
      session.latestFrameRef = `/redis-camera-streams/${filename}`;
      session.updatedAt = capturedAt;
      if (typeof db.saveDb === 'function') db.saveDb();
      cleanupOldFrameFile(previousRef);
      return json(res, 200, { success: true, sequence: nextSequence, capturedAt, frameRef: session.latestFrameRef });
    }

    if (pathname === '/api/trip/camera/frame' && req.method === 'GET') {
      const sessionId = String(parsedUrl.query.session_id || '');
      const session = getSession(db, sessionId);
      if (!session || session.status !== 'LIVE') return json(res, 404, { success: false, error: 'Live camera session not available.' });
      if (Date.now() > Date.parse(session.expiresAt)) return json(res, 410, { success: false, error: 'Camera session expired.' });
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['DRIVER', 'CUSTOMER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'], targetOrderId: session.tripId })) return true;
      const stored = await redisPubSub.pubClient.get(frameKey(sessionId));
      if (!stored) return json(res, 404, { success: false, error: 'Live camera frame not available.' });
      let frame;
      try { frame = JSON.parse(stored); } catch (_) { return json(res, 500, { success: false, error: 'Live camera frame is corrupt.' }); }
      const bytes = Buffer.from(frame.data, 'base64');
      const types = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
      res.writeHead(200, { 'Content-Type': types[frame.format] || 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'X-Frame-Sequence': String(frame.sequence), 'X-Captured-At': frame.capturedAt, 'X-Content-Type-Options': 'nosniff' });
      res.end(bytes);
      return true;
    }

    if (pathname === '/api/trip/camera/session/stop' && req.method === 'POST') {
      const parsed = await readJsonBody(req);
      if (parsed.error) return json(res, parsed.error === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { success: false, error: parsed.error });
      const sessionId = String(parsed.data?.session_id || '');
      const session = getSession(db, sessionId);
      if (!session) return json(res, 404, { success: false, error: 'Camera session not found.' });
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'], targetOrderId: session.tripId })) return true;
      session.status = 'STOPPED'; session.updatedAt = new Date().toISOString();
      await redisPubSub.pubClient.del(frameKey(sessionId));
      if (typeof db.saveDb === 'function') db.saveDb();
      return json(res, 200, { success: true, sessionId, status: session.status });
    }

    if (pathname === '/api/trip/proof-photo' && req.method === 'POST') {
      let body = ''; let tooLarge = false;
      req.on('data', chunk => { if (body.length + chunk.length > MAX_REQUEST_BYTES) { tooLarge = true; return; } body += chunk; });
      req.on('end', async () => {
        if (tooLarge) return json(res, 413, { success: false, error: 'Proof photo exceeds the upload size.' });
        let data; try { data = JSON.parse(body); } catch (_) { return json(res, 400, { success: false, error: 'Invalid JSON payload.' }); }
        const tripId = typeof data.trip_id === 'string' ? data.trip_id : '';
        if (!await enforceSecurityChecks(req, res, { requiredRoles: ['DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'], targetOrderId: tripId })) return;
        const image = parseImage(data.image_data, MAX_PHOTO_BYTES);
        if (!image) return json(res, 400, { success: false, error: 'A JPEG, PNG, or WebP proof photo is required.' });
        if (!tripId || !(db.getTrips ? db.getTrips() : []).some(t => t.id === tripId)) return json(res, 404, { success: false, error: 'Trip not found.' });
        const id = `pod_${crypto.randomBytes(16).toString('hex')}`;
        const extension = image.format === 'jpeg' ? 'jpg' : image.format;
        fs.mkdirSync(PRIVATE_PROOF_PHOTOS, { recursive: true });
        fs.writeFileSync(path.join(PRIVATE_PROOF_PHOTOS, `${id}.${extension}`), image.bytes, { flag: 'wx', mode: 0o600 });
        return json(res, 200, { success: true, proofPhotoRef: `/private-proof-photos/${id}.${extension}` });
      });
      return true;
    }

    if (pathname === '/api/trip/proof-photo' && req.method === 'GET') {
      const ref = String(parsedUrl.query.ref || '');
      const match = ref.match(/^\/private-proof-photos\/(pod_[a-f0-9]{32}\.(jpg|png|webp))$/);
      if (!match) { res.writeHead(404); res.end('Not found'); return true; }
      const trip = (db.getTrips ? db.getTrips() : []).find(t => t.proofOfDelivery && t.proofOfDelivery.podPhotoUrl === ref);
      if (!trip) { res.writeHead(404); res.end('Not found'); return true; }
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'], targetOrderId: trip.id })) return true;
      const filePath = path.resolve(PRIVATE_PROOF_PHOTOS, match[1]);
      if (!filePath.startsWith(PRIVATE_PROOF_PHOTOS + path.sep)) { res.writeHead(404); res.end('Not found'); return true; }
      fs.readFile(filePath, (error, file) => {
        if (error) { res.writeHead(404); res.end('Not found'); return; }
        const types = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
        res.writeHead(200, { 'Content-Type': types[match[2]], 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(file);
      });
      return true;
    }

    return false;
  };
}

module.exports = { createProofRoutes, PRIVATE_PROOF_PHOTOS, PRIVATE_CAMERA_STREAMS };