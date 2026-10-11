// Driver live location, telemetry history, nearby search, WebSocket room subscription, and availability.
// Branch logic is moved unchanged from server_production.js. Each matched route answers and returns true
// at once, so the router stops here, including when a guard has already refused the request.

function createDriverTelemetryRoutes({ db, driverLocationService, websocketService, enforceDriverAccess, enforceSecurityChecks, parseJsonBody, validateFields }) {
  return async function handleDriverTelemetryRoute(req, res, { pathname, parsedUrl }) {
    // Driver GPS telemetry ingest and real-time location update.
    if (pathname === '/api/driver/location/update' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const driverId = data.driverId || null;
        if (!await enforceDriverAccess(req, res, driverId, 'driver:telemetry')) return;
        data.driverId = req.authorizedDriverId;
        const result = await websocketService.handleDriverLocationPing(req.authorizedDriverId, data);

        if (!result.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: result.reason }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          driver: result.driverState
        }));
      });
      return true;
    }

    // Query driver telemetry state.
    if (pathname === '/api/driver/location' && req.method === 'GET') {
      const driverId = parsedUrl.query.driverId || null;
      if (!await enforceDriverAccess(req, res, driverId, 'driver:location')) return true;
      const state = await driverLocationService.getDriverState(driverId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: Boolean(state),
        driver: state || null
      }));
      return true;
    }

    // Clear driver telemetry state (admin / test utility).
    if (pathname === '/api/driver/location/clear' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const driverId = data.driverId || null;
        if (!await enforceDriverAccess(req, res, driverId, 'driver:location:clear')) return;
        await driverLocationService.clearDriverLocation(req.authorizedDriverId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, driverId }));
      });
      return true;
    }

    // Driver location audit history.
    if (pathname === '/api/driver/history' && req.method === 'GET') {
      const driverId = parsedUrl.query.driverId || null;
      if (!await enforceDriverAccess(req, res, driverId, 'driver:history')) return true;
      const tripId = parsedUrl.query.tripId || null;
      const history = await driverLocationService.getDriverHistory(driverId, tripId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        driverId,
        tripId,
        count: history.length,
        history
      }));
      return true;
    }

    // Nearby available drivers spatial search.
    if (pathname === '/api/drivers/nearby' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'drivers:nearby', requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] })) return true;
      const lat = parseFloat(parsedUrl.query.lat);
      const lng = parseFloat(parsedUrl.query.lng);
      const radiusKm = parseFloat(parsedUrl.query.radiusKm) || 10;
      const vehicleId = parsedUrl.query.vehicleId || null;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Valid lat and lng are required.' }));
        return true;
      }

      const nearby = await driverLocationService.findNearbyDrivers(lat, lng, radiusKm, vehicleId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        center: { lat, lng },
        radiusKm,
        count: nearby.length,
        drivers: nearby
      }));
      return true;
    }

    // WebSocket room subscription and authorization.
    if (pathname === '/api/ws/subscribe' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceSecurityChecks(req, res, { routeName: 'ws:subscribe', requiredRoles: ['CUSTOMER', 'MERCHANT', 'DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'] })) return;

        const { roomName } = data;
        if (!validateFields(res, [
          [typeof roomName === 'string' && roomName.length >= 1 && roomName.length <= 128, 'roomName is required, up to 128 characters'],
        ])) return;
        const clientType = req.user.role === 'DRIVER' ? 'DRIVER' : (req.user.role === 'MERCHANT' ? 'MERCHANT' : 'CUSTOMER');
        const dummySocket = { send: () => {} };
        const clientId = websocketService.registerClient(dummySocket, clientType, req.user.id, req.user.role);
        const subResult = websocketService.joinRoom(clientId, roomName);

        if (!subResult.success) {
          websocketService.unregisterClient(clientId);
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: subResult.error }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          clientId,
          roomName,
          authorized: true
        }));
      });
      return true;
    }

    // Driver availability toggle (the first of two copies; see PRODUCT_ISSUES.md).
    if (pathname === '/api/driver/status' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const driverId = data.driverId || null;
        if (!await enforceDriverAccess(req, res, driverId, 'driver:status')) return;
        if (!validateFields(res, [
          [data.isOnline === undefined || typeof data.isOnline === 'boolean', 'isOnline must be true or false'],
        ])) return;
        const isOnline = data.isOnline !== undefined ? data.isOnline : true;
        if (!isOnline) {
          const activeStatuses = new Set(['DRIVER_ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_AT_PICKUP', 'PICKUP_CONFIRMED', 'IN_TRANSIT', 'DRIVER_AT_DROPOFF']);
          const activeTrip = (db.getTrips() || []).find(trip => activeStatuses.has(trip.status) && String(trip.driver?.id || trip.driver?.userId) === String(req.authorizedDriverId));
          if (activeTrip) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: { code: 'DRIVER_HAS_ACTIVE_TRIP', message: 'Complete or resolve the active delivery before going offline.' } }));
          }
        }

        const result = await driverLocationService.setDriverAvailability(req.authorizedDriverId, isOnline);
        const status = isOnline ? 'ONLINE' : 'OFFLINE';
        if (db.updateDriverProfile) db.updateDriverProfile(req.authorizedDriverId, { status });
        else if (db.updateDriverStatus) db.updateDriverStatus(req.authorizedDriverId, status);
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      });
      return true;
    }

    return false;
  };
}

module.exports = { createDriverTelemetryRoutes };
