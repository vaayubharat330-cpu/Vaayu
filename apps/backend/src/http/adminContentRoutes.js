// Advertisements, operational zones, disputes and refunds, broadcast campaigns, and CSV exports. Branch logic is moved
// from server_production.js. Each matched route answers and returns true at once, so the router stops here, including
// when a guard has refused the request. Access for the path groups is enforced by the dispatcher's prefix guards.

const { validateFields, csvCell } = require('./helpers');

function createAdminContentRoutes({ db, paymentProvider, notificationProvider, enforceSecurityChecks, parseJsonBody }) {
  return async function handleAdminContentRoute(req, res, { pathname }) {
    if (pathname === '/api/admin/advertisements' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        advertisements: db.getAdvertisements ? db.getAdvertisements() : []
      }));
      return true;
    }

    if (pathname === '/api/admin/advertisements/create' && req.method === 'POST') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'admin:advertisement-create', requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return true;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
        if (!String(data.businessName || '').trim() || !String(data.title || '').trim() || (data.actionUrl && !/^(https?:\/\/|tel:|mailto:)/i.test(data.actionUrl))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Business name, title, and a safe http(s), tel, or mailto action URL are required.' }));
        }
        const createdAd = db.createAdvertisement ? db.createAdvertisement(data) : null;
        res.writeHead(createdAd ? 201 : 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(createdAd ? { success: true, advertisement: createdAd } : { success: false, error: 'Could not create advertisement.' }));
      });
      return true;
    }

    if (pathname === '/api/admin/advertisements/update-status' && req.method === 'POST') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'admin:advertisement-update', requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return true;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
        if (!data.adId || !['ACTIVE', 'PAUSED'].includes(String(data.status || '').toUpperCase())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'adId and a status of ACTIVE or PAUSED are required.' }));
        }
        const updated = db.updateAdvertisementStatus ? db.updateAdvertisementStatus(data.adId, data.status) : null;
        res.writeHead(updated ? 200 : 404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(updated ? { success: true, advertisement: updated } : { success: false, error: 'Advertisement not found.' }));
      });
      return true;
    }

    if (pathname === '/api/admin/advertisements/delete' && req.method === 'POST') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'admin:advertisement-delete', requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return true;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
        const deleted = data.adId && db.deleteAdvertisement ? db.deleteAdvertisement(data.adId) : false;
        res.writeHead(deleted ? 200 : 404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(deleted ? { success: true, message: 'Advertisement deleted.' } : { success: false, error: 'Advertisement not found.' }));
      });
      return true;
    }

    if (pathname === '/api/advertisements/active' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        advertisements: db.getActiveAdvertisements ? db.getActiveAdvertisements() : []
      }));
      return true;
    }

    if (pathname === '/api/advertisements/click' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!validateFields(res, [
          [data.adId === undefined || (typeof data.adId === 'string' && data.adId.length <= 128), 'adId must be text up to 128 characters'],
        ])) return;
        if (!db.incrementAdClick) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: { code: 'FEATURE_UNAVAILABLE', message: 'Ad click tracking is not available on this server.' } }));
        }
        db.incrementAdClick(data.adId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      });
      return true;
    }

    if (pathname === '/api/admin/zones' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        zones: db.getZones ? db.getZones() : []
      }));
      return true;
    }

    if (pathname === '/api/admin/zones/update-surge' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
        if (!data.zoneId || !Number.isFinite(Number(data.surgeMultiplier)) || Number(data.surgeMultiplier) < 1 || Number(data.surgeMultiplier) > 3) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'zoneId and a multiplier from 1.0 to 3.0 are required.' }));
        }
        const updated = db.updateZoneSurge ? db.updateZoneSurge(data.zoneId, data.surgeMultiplier) : null;
        res.writeHead(updated ? 200 : 404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(updated ? { success: true, zone: updated } : { success: false, error: 'Zone not found.' }));
      });
      return true;
    }

    if (pathname === '/api/admin/zones/toggle-status' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
        if (!data.zoneId || !['ACTIVE', 'RESTRICTED'].includes(String(data.status || '').toUpperCase())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'zoneId and status ACTIVE or RESTRICTED are required.' }));
        }
        const updated = db.toggleZoneStatus ? db.toggleZoneStatus(data.zoneId, String(data.status).toUpperCase()) : null;
        res.writeHead(updated ? 200 : 404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(updated ? { success: true, zone: updated } : { success: false, error: 'Zone not found.' }));
      });
      return true;
    }

    if (pathname === '/api/admin/zones/create' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
        if (!String(data.name || '').trim() || !String(data.city || '').trim() || String(data.name).length > 120 || String(data.city).length > 80) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Zone name and city are required and must be within 120 and 80 characters.' }));
        }
        const hasAnyGeofence = ['centerLat', 'centerLng', 'radiusKm'].some(key => String(data[key] ?? '').trim() !== '');
        if (data.tollFee !== undefined && (!Number.isFinite(Number(data.tollFee)) || Number(data.tollFee) < 0 || Number(data.tollFee) > 100000)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Toll fee must be between ₹0 and ₹100,000.' }));
        }
        if (hasAnyGeofence && (!Number.isFinite(Number(data.centerLat)) || Number(data.centerLat) < -90 || Number(data.centerLat) > 90 || !Number.isFinite(Number(data.centerLng)) || Number(data.centerLng) < -180 || Number(data.centerLng) > 180 || !Number.isFinite(Number(data.radiusKm)) || Number(data.radiusKm) <= 0 || Number(data.radiusKm) > 100)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Provide a complete geofence with valid center latitude, longitude, and radius (0–100 km).' }));
        }
        const created = db.createZone ? db.createZone(data) : null;
        res.writeHead(created ? 201 : 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(created ? { success: true, zone: created } : { success: false, error: 'Could not create zone.' }));
      });
      return true;
    }

    if (pathname === '/api/admin/disputes' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        disputes: db.getDisputes ? db.getDisputes() : []
      }));
      return true;
    }

    if (pathname === '/api/admin/disputes/resolve' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
        const action = String(data.action || '').toUpperCase();
        const dispute = (db.getDisputes ? db.getDisputes() : []).find(item => item.id === data.disputeId);
        const amount = Number(data.amount);
        if (!dispute || !['APPROVE', 'REJECT'].includes(action) || (action === 'APPROVE' && (!Number.isFinite(amount) || amount <= 0 || amount > Number(dispute.requestedRefund || 0)))) {
          res.writeHead(dispute ? 400 : 404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: dispute ? 'Choose APPROVE or REJECT and approve an amount up to the requested refund.' : 'Dispute not found.' }));
        }
        const updated = db.resolveDispute ? db.resolveDispute(data.disputeId, action, amount, req.user.name || req.user.id, data.notes) : null;
        res.writeHead(updated ? 200 : 409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(updated ? { success: true, dispute: updated } : { success: false, error: 'This dispute has already been resolved.' }));
      });
      return true;
    }

    if (pathname === '/api/admin/integrations/status' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'admin:integration-status', requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return true;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
      res.end(JSON.stringify({
        success: true,
        integrations: {
          payments: { provider: 'razorpay', configured: paymentProvider.configured, capability: 'orders, signature verification, refunds' },
          payouts: { provider: 'razorpayx', configured: paymentProvider.configured && process.env.VAAYU_ENABLE_RAZORPAYX_PAYOUTS === 'true' && Boolean(process.env.RAZORPAYX_ACCOUNT_NUMBER), enabled: process.env.VAAYU_ENABLE_RAZORPAYX_PAYOUTS === 'true', ledgerReady: false, capability: 'admin-reviewed UPI payouts; live use blocked until driver earnings ledger is durable' },
          messaging: { provider: notificationProvider.configured ? 'signed HTTPS webhook' : null, configured: notificationProvider.configured, capability: 'broadcast dispatch' },
          documentOcr: { provider: documentOcrProvider.configured ? 'azure-document-intelligence' : null, configured: documentOcrProvider.configured, capability: 'read extraction; human review remains required' },
          deployment: { configured: false, capability: 'production deployment requires durable transactional persistence and migrations' }
        }
      }));
      return true;
    }

    if (pathname === '/api/admin/broadcasts' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        broadcasts: db.getBroadcasts ? db.getBroadcasts() : []
      }));
      return true;
    }

    if (pathname === '/api/admin/broadcasts/send' && req.method === 'POST') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'admin:broadcast-queue', requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return true;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let data = {};
        try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
        if (!String(data.title || '').trim() || !String(data.messageText || '').trim() || !['WHATSAPP', 'SMS', 'EMAIL', 'PUSH_NOTIFICATION'].includes(String(data.channel || '').toUpperCase()) || !['ALL_CUSTOMERS', 'ALL_DRIVERS'].includes(String(data.targetAudience || '').toUpperCase())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Campaign title, message, supported channel, and audience are required.' }));
        }
        const created = db.sendBroadcast ? db.sendBroadcast(data) : null;
        if (!created) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Could not queue broadcast.' })); }
        try {
          const delivery = await notificationProvider.sendCampaign(created);
          const updated = db.updateBroadcastDelivery ? db.updateBroadcastDelivery(created.id, delivery.status, delivery.configured ? null : 'Messaging provider is not configured; nothing was sent.') : created;
          res.writeHead(201, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, broadcast: updated, delivery: delivery.status, providerConfigured: delivery.configured }));
        } catch (error) {
          const updated = db.updateBroadcastDelivery ? db.updateBroadcastDelivery(created.id, 'DELIVERY_FAILED', error.message) : created;
          res.writeHead(201, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, broadcast: updated, delivery: 'DELIVERY_FAILED', providerConfigured: notificationProvider.configured, error: error.message }));
        }
      });
      return true;
    }

    if (pathname === '/api/admin/export/trips' && req.method === 'GET') {
      const trips = db.getTrips ? db.getTrips() : [];
      let csv = 'Trip ID,Customer Name,Pickup Address,Drop Address,Vehicle,Total Fare,Status,Date\n';
      trips.forEach(t => {
        csv += [t.id, t.senderName || 'Customer', t.pickupAddress, t.dropAddress, t.vehicleName, t.totalFare, t.status, t.createdAt || ''].map(csvCell).join(',') + '\n';
      });
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="vaayu_trips_export.csv"'
      });
      res.end(csv);
      return true;
    }

    if (pathname === '/api/admin/export/drivers' && req.method === 'GET') {
      const drivers = db.getDrivers ? db.getDrivers() : [];
      let csv = 'Driver ID,Name,Phone,Vehicle Name,Vehicle Number,License Number,KYC Status,Status,Rating,Today Earnings\n';
      drivers.forEach(d => {
        csv += [d.id, d.name, d.phone, d.vehicleName, d.vehicleNumber, d.licenseNumber, d.kycStatus, d.status, d.rating, d.todayEarnings].map(csvCell).join(',') + '\n';
      });
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="vaayu_drivers_export.csv"'
      });
      res.end(csv);
      return true;
    }

    if (pathname === '/api/admin/export/customers' && req.method === 'GET') {
      const customers = db.getCustomers ? db.getCustomers() : [];
      let csv = 'Customer ID,Name,Phone,Email,City,Joined Date\n';
      customers.forEach(c => {
        csv += [c.id, c.name, c.phone, c.email || '', c.city || 'Hyderabad', c.createdAt || ''].map(csvCell).join(',') + '\n';
      });
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="vaayu_customers_export.csv"'
      });
      res.end(csv);
      return true;
    }

    return false;
  };
}

module.exports = { createAdminContentRoutes };
