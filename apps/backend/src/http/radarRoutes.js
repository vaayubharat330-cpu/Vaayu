// Nearby driver radar for operators. Branch logic is moved from server_production.js unchanged. The route answers and
// returns true at once, so the router stops here.

function createRadarRoutes({ db, enforceSecurityChecks }) {
  return async function handleRadarRoute(req, res, { pathname, parsedUrl }) {
    if (pathname === '/api/telemetry/nearby-drivers' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'telemetry:nearby-drivers', requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] })) return true;
      const lat = parseFloat(parsedUrl.query.lat);
      const lng = parseFloat(parsedUrl.query.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Valid lat and lng are required.' }));
        return true;
      }
      const radius = parseFloat(parsedUrl.query.radius || 10);
      const drivers = db.getNearbyDrivers ? db.getNearbyDrivers(lat, lng, radius) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, drivers }));
      return true;
    }

    return false;
  };
}

module.exports = { createRadarRoutes };
