// Proof-of-delivery photos. The assigned driver uploads a JPEG, PNG, or WebP as base64; the server stores it privately
// and returns a reference. The reference is attached to the trip only when the delivery code passes (see
// deliveryStateMachine), so an unverified hand-over never gets proof. Each matched route answers and returns true at
// once, so the router stops here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const PRIVATE_PROOF_PHOTOS = path.resolve(BACKEND_ROOT, 'private_uploads', 'proof_photos');
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
// Base64 adds about a third, so the request ceiling is above the 5 MB decoded limit.
const MAX_REQUEST_BYTES = 7.5 * 1024 * 1024;

function createProofRoutes({ db, enforceDriverAccess, enforceSecurityChecks }) {
  return async function handleProofRoute(req, res, { pathname, parsedUrl }) {
    if (pathname === '/api/trip/proof-photo' && req.method === 'POST') {
      let body = '';
      let tooLarge = false;
      req.on('data', chunk => {
        if (body.length + chunk.length > MAX_REQUEST_BYTES) { tooLarge = true; return; }
        body += chunk;
      });
      req.on('end', async () => {
        if (tooLarge) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Proof photo exceeds the upload size.' }));
        }
        let data;
        try { data = JSON.parse(body); } catch (_) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' }));
        }
        const tripId = typeof data.trip_id === 'string' ? data.trip_id : '';
        if (!await enforceSecurityChecks(req, res, { requiredRoles: ['DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'], targetOrderId: tripId })) return;
        const match = typeof data.image_data === 'string' && data.image_data.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!match) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'A JPEG, PNG, or WebP proof photo is required.' }));
        }
        const bytes = Buffer.from(match[2], 'base64');
        if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Proof photos must be 5 MB or smaller.' }));
        }
        if (!tripId || !(db.getTrips ? db.getTrips() : []).some(t => t.id === tripId)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Trip not found.' }));
        }
        const id = `pod_${crypto.randomBytes(16).toString('hex')}`;
        const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
        fs.mkdirSync(PRIVATE_PROOF_PHOTOS, { recursive: true });
        fs.writeFileSync(path.join(PRIVATE_PROOF_PHOTOS, `${id}.${extension}`), bytes, { flag: 'wx', mode: 0o600 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, proofPhotoRef: `/private-proof-photos/${id}.${extension}` }));
      });
      return true;
    }

    if (pathname === '/api/trip/proof-photo' && req.method === 'GET') {
      const ref = String(parsedUrl.query.ref || '');
      const match = ref.match(/^\/private-proof-photos\/(pod_[a-f0-9]{32}\.(jpg|png|webp))$/);
      if (!match) {
        res.writeHead(404); res.end('Not found'); return true;
      }
      const trip = (db.getTrips ? db.getTrips() : []).find(t => t.proofOfDelivery && t.proofOfDelivery.podPhotoUrl === ref);
      if (!trip) {
        res.writeHead(404); res.end('Not found'); return true;
      }
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'], targetOrderId: trip.id })) return true;
      const filePath = path.resolve(PRIVATE_PROOF_PHOTOS, match[1]);
      if (!filePath.startsWith(PRIVATE_PROOF_PHOTOS + path.sep)) {
        res.writeHead(404); res.end('Not found'); return true;
      }
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

module.exports = { createProofRoutes, PRIVATE_PROOF_PHOTOS };
