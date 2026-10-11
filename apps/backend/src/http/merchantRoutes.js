// Merchant (B2B) read and staff routes: proof-of-delivery PDF, staff list and add, and merchant profile. Branch logic is
// moved from server_production.js unchanged. Access to /api/merchant/* is checked by the dispatcher before these run.
// Each matched route answers and returns true at once, so the router stops here.

function createMerchantRoutes({ db, createTextPdf, parseJsonBody, validateFields }) {
  return async function handleMerchantRoute(req, res, { pathname, parsedUrl }) {
    const merchantPodMatch = pathname.match(/^\/api\/merchant\/pod\/([^/]+)$/);
    if (merchantPodMatch && req.method === 'GET') {
      let tripId;
      try { tripId = decodeURIComponent(merchantPodMatch[1]); }
      catch (_) { res.writeHead(400); res.end('Invalid trip id'); return true; }
      const trip = db.getTripById(tripId);
      if (!trip || trip.merchantId !== req.authorizedMerchantId && trip.merchant_id !== req.authorizedMerchantId) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
        res.end(JSON.stringify({ success: false, error: 'Delivery record not found.' }));
        return true;
      }
      const pod = db.getProofOfDelivery ? db.getProofOfDelivery(trip.id) : null;
      if (!pod) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
        res.end(JSON.stringify({ success: false, error: 'No proof of delivery is available for this shipment.' }));
        return true;
      }
      const merchant = (db.getMerchants ? db.getMerchants(req.authorizedMerchantId) : [])[0] || {};
      const pdf = createTextPdf([
        'VAAYU - PROOF OF DELIVERY',
        `Shipment: ${trip.id}`,
        `Merchant: ${merchant.businessName || merchant.id || req.authorizedMerchantId}`,
        `Status: ${trip.status || 'UNKNOWN'}`,
        `Delivered to: ${pod.receiverName || 'Not recorded'}`,
        `Drop address: ${trip.dropAddress || 'Not recorded'}`,
        `Evidence captured: ${pod.timestamp || 'Not recorded'}`,
        `Receiver signature: ${pod.receiverSignature ? 'Recorded' : 'Not recorded'}`,
        `Delivery photo: ${pod.podPhotoUrl ? 'Recorded' : 'Not recorded'}`
      ]);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': pdf.length,
        'Content-Disposition': `attachment; filename="vaayu-pod-${encodeURIComponent(trip.id)}.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(pdf);
      return true;
    }

    if (pathname === '/api/merchant/staff' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, staff: db.getMerchantStaff ? db.getMerchantStaff(req.authorizedMerchantId) : [] }));
      return true;
    }

    if (pathname === '/api/merchant/staff' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!validateFields(res, [
          [data.role === undefined || ['OWNER', 'STORE_MANAGER', 'BILLING'].includes(data.role), 'role must be OWNER, STORE_MANAGER, or BILLING'],
          [data.branch === undefined || (typeof data.branch === 'string' && data.branch.length <= 80), 'branch must be text up to 80 characters'],
        ])) return;
        const result = db.addMerchantStaff ? db.addMerchantStaff(req.authorizedMerchantId, data) : { success: false, error: 'Staff service is unavailable.' };
        res.writeHead(result.success ? 201 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
      return true;
    }

    if (pathname === '/api/merchant/profile' && req.method === 'GET') {
      const merchantId = req.authorizedMerchantId || parsedUrl.query.merchant_id || parsedUrl.query.merchantId || null;
      const phone = req.user.role === 'MERCHANT' ? req.user.phone : (parsedUrl.query.phone || null);
      const merchants = db.getMerchants ? db.getMerchants(merchantId, phone) : [];
      if (!merchants.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Merchant account not found.' }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, merchant: merchants[0] }));
      return true;
    }

    return false;
  };
}

module.exports = { createMerchantRoutes };
