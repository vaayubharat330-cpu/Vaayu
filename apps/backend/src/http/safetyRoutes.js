// Waiting-time fee, SOS trigger, and SOS alert list routes. Branch logic is moved from server_production.js unchanged.
// The SOS trigger keeps its driver check ahead of the field checks. The alert list keeps its role gate. Each matched
// route answers and returns true at once, so the router stops here.

function createSafetyRoutes({ db, enforceSecurityChecks, enforceDriverAccess, parseJsonBody, validateFields, isLatitude, isLongitude }) {
  return async function handleSafetyRoute(req, res, { pathname }) {
    if (pathname === '/api/trip/calculate-waiting-fee' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!validateFields(res, [
          [Number.isFinite(Number(data.waiting_minutes)) && Number(data.waiting_minutes) >= 0 && Number(data.waiting_minutes) <= 1440, 'waiting_minutes must be between 0 and 1440'],
        ])) return;
        const resData = db.calculateWaitingTimeFee ? db.calculateWaitingTimeFee(data.waiting_minutes, data.vehicle_category) : { success: false, error: { code: 'FEATURE_UNAVAILABLE', message: 'This feature is not available on this server.' } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resData));
      });
      return true;
    }

    if (pathname === '/api/safety/sos-trigger' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceDriverAccess(req, res, data.driver_id || null, 'driver:sos')) return;
        const sosLat = typeof data.lat === 'string' && data.lat.trim() !== '' ? Number(data.lat) : data.lat;
        const sosLng = typeof data.lng === 'string' && data.lng.trim() !== '' ? Number(data.lng) : data.lng;
        if (!validateFields(res, [
          [isLatitude(sosLat), 'lat must be a valid latitude'],
          [isLongitude(sosLng), 'lng must be a valid longitude'],
        ])) return;
        const resData = db.triggerSosEmergency ? db.triggerSosEmergency(req.authorizedDriverId, data.trip_id, data.lat, data.lng) : { success: false, error: { code: 'FEATURE_UNAVAILABLE', message: 'This feature is not available on this server.' } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resData));
      });
      return true;
    }

    if (pathname === '/api/safety/alerts' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'] })) return true;
      const alerts = db.getSosAlerts ? db.getSosAlerts() : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, alerts }));
      return true;
    }

    return false;
  };
}

module.exports = { createSafetyRoutes };
