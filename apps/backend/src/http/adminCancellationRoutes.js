// Admin rejection review, rejection proof video, and driver payout approval. Branch logic is moved from
// server_production.js. Each matched route answers and returns true at once, so the router stops here.

const fs = require('fs');
const path = require('path');
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const REJECTION_PROOFS = path.resolve(BACKEND_ROOT, 'private_uploads', 'rejection_proofs');

function createAdminCancellationRoutes({ db, paymentProvider, enforceSecurityChecks, parseJsonBody }) {
  return async function handleAdminCancellationRoute(req, res, { pathname, parsedUrl }) {
    if (pathname === '/api/admin/rejections' && req.method === 'GET') {
      const rejections = db.getOrderRejections ? db.getOrderRejections() : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, rejections }));
      return true;
    }

    if (pathname === '/api/admin/rejections/proof' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'admin:rejection-proof', requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] })) return true;
      const filename = String(parsedUrl.query.id || '');
      if (!/^proof_\d+_[a-f0-9]{16}\.(?:webm|mp4)$/.test(filename) || path.basename(filename) !== filename) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        res.end('Not found');
        return true;
      }
      const storedUrl = `/api/admin/rejections/proof?id=${encodeURIComponent(filename)}`;
      const associatedRecord = (db.getOrderRejections ? db.getOrderRejections() : []).some(record => record.videoUrl === storedUrl);
      if (!associatedRecord) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        res.end('Not found');
        return true;
      }
      const filePath = path.resolve(REJECTION_PROOFS, filename);
      if (!filePath.startsWith(REJECTION_PROOFS + path.sep)) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        res.end('Not found');
        return true;
      }
      fs.readFile(filePath, (error, file) => {
        if (error) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': filename.endsWith('.mp4') ? 'video/mp4' : 'video/webm', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(file);
      });
      return true;
    }

    if (pathname === '/api/admin/rejections/update' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
        const action = String(data.action || '').toUpperCase();
        if (!data.rejectionId || !['APPROVE', 'REJECT'].includes(action)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'rejectionId and action APPROVE or REJECT are required.' }));
        }
        const existing = (db.getOrderRejections ? db.getOrderRejections() : []).find(item => item.id === data.rejectionId);
        if (!existing) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Rejection not found.' })); }
        if (existing.status !== 'PENDING_REVIEW' || (action === 'APPROVE' && !existing.videoUrl)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: existing.status !== 'PENDING_REVIEW' ? 'Rejection has already been reviewed.' : 'Cannot approve a rejection without video proof.' }));
        }
        const updated = db.updateOrderRejection ? db.updateOrderRejection(data.rejectionId, action, data.notes) : null;
        res.writeHead(updated ? 200 : 409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(updated ? { success: true, rejection: updated } : { success: false, error: 'Could not review rejection.' }));
      });
      return true;
    }

    if (pathname === '/api/admin/payouts' && req.method === 'GET') {
      const payouts = db.getPayouts ? db.getPayouts() : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, payouts }));
      return true;
    }

    if (pathname === '/api/admin/payouts/approve' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let data = {};
        try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
        const action = String(data.action || '').toUpperCase();
        if (!data.payoutId || !['APPROVE', 'REJECT'].includes(action)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'payoutId and action APPROVE or REJECT are required.' }));
        }
        const updated = db.approvePayout ? db.approvePayout(data.payoutId, action, data.notes) : null;
        if (updated && action === 'APPROVE' && process.env.VAAYU_ENABLE_RAZORPAYX_PAYOUTS === 'true') {
          try {
            const transfer = await paymentProvider.createUpiPayout({
              amount: updated.amount,
              upiId: updated.upiId,
              name: updated.driverName,
              phone: updated.driverPhone,
              referenceId: updated.id,
              idempotencyKey: updated.id
            });
            const savedTransfer = db.updatePayoutTransfer ? db.updatePayoutTransfer(updated.id, transfer) : null;
            res.writeHead(savedTransfer ? 200 : 500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(savedTransfer ? { success: true, payout: savedTransfer, transfer } : { success: false, payoutApproved: true, error: 'Provider accepted the transfer but local payout status could not be saved. Reconcile with RazorpayX before any retry.' }));
          } catch (error) {
            res.writeHead(202, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, payout: updated, transfer: 'NOT_CONFIRMED', error: error.message, retryWithSamePayoutId: true }));
          }
        }
        res.writeHead(updated ? 200 : 409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(updated ? { success: true, payout: updated } : { success: false, error: 'Payout not found or already reviewed.' }));
      });
      return true;
    }

    return false;
  };
}

module.exports = { createAdminCancellationRoutes };
