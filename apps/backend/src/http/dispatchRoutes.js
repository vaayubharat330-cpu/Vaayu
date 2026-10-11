// Dispatch matcher, driver decline, routing and ETA, and live trip ETA. Branch logic is moved from
// server_production.js. Each matched route answers and returns true at once, so the router stops here,
// including when a guard has refused the request.
// The routing calculate and ETA routes stay public: the customer map flow calls them before sign-in.

function createDispatchRoutes({
  db, dispatchService, mapEngine, driverLocationService, enforceSecurityChecks, enforceDriverAccess, parseJsonBody, redisRateLimiter
}) {
  // Public map routes share one per-client limit. Returns true when the request was refused and answered.
  async function refusedByMapLimit(req, res) {
    const rateCheck = await redisRateLimiter.checkRateLimit(req, res, 'public:map');
    if (rateCheck.error && process.env.NODE_ENV === 'production') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Security rate limiting is unavailable.' }));
      return true;
    }
    if (!rateCheck.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: rateCheck.message || 'Too many requests. Try again later.' }));
      return true;
    }
    return false;
  }

  return async function handleDispatchRoute(req, res, { pathname, parsedUrl }) {
    // Manual dispatch match for operators.
    if (pathname === '/api/dispatch/match' && req.method === 'POST') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'dispatch:manual-match', requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] })) return true;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const orderId = data.orderId;
        if (!orderId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'orderId is required' }));
        }

        const matchResult = await dispatchService.findAndOfferDriver(orderId);
        res.writeHead(matchResult.success ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(matchResult));
      });
      return true;
    }

    // A driver declines an offer. Only the driver the offer is assigned to may decline it.
    if (pathname === '/api/dispatch/decline' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const { orderId, driverId, reason } = data;
        if (!orderId || !driverId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'orderId and driverId are required' }));
        }

        if (!await enforceDriverAccess(req, res, driverId, 'dispatch:decline')) return;
        const trip = db.getTripById(orderId);
        const assignedId = trip?.driver?.id || trip?.driver?.userId;
        if (!trip || String(assignedId) !== String(req.authorizedDriverId)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN_OFFER', message: 'This offer is not assigned to your driver profile.' } }));
        }

        const declineResult = await dispatchService.handleDriverDecline(orderId, req.authorizedDriverId, reason || 'Driver declined dispatch offer');
        res.writeHead(declineResult.success ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(declineResult));
      });
      return true;
    }

    // Candidate drivers for a trip (operators).
    if (pathname === '/api/dispatch/candidates' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'dispatch:candidates', requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] })) return true;
      const orderId = parsedUrl.query.orderId;
      if (!orderId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'orderId is required' }));
        return true;
      }

      const trip = db.getTripById(orderId);
      if (!trip) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Order not found' }));
        return true;
      }

      const candidates = await dispatchService.getCandidateDrivers(trip);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        orderId,
        count: candidates.length,
        candidates
      }));
      return true;
    }

    // Current offer status for a trip (operators).
    if (pathname === '/api/dispatch/offer' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'dispatch:offer', requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] })) return true;
      const orderId = parsedUrl.query.orderId;
      if (!orderId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'orderId is required' }));
        return true;
      }

      const offerStatus = dispatchService.getOfferStatus(orderId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        orderId,
        offer: offerStatus
      }));
      return true;
    }

    // Route calculation for the map flow.
    if (pathname === '/api/routing/calculate' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (await refusedByMapLimit(req, res)) return;

        const { pickupLat, pickupLng, dropLat, dropLng, intermediateStops, vehicleId, isOutstation, provider, bypassCache } = data;
        if (pickupLat == null || pickupLng == null || dropLat == null || dropLng == null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'pickupLat, pickupLng, dropLat, dropLng are required' }));
        }

        let result;
        try {
          result = await mapEngine.routing.calculateRoute(
            parseFloat(pickupLat),
            parseFloat(pickupLng),
            parseFloat(dropLat),
            parseFloat(dropLng),
            intermediateStops || [],
            { vehicleId, isOutstation, provider, bypassCache }
          );
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: error.message }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          ...result
        }));
      });
      return true;
    }

    // Point-to-point ETA for the map flow.
    if (pathname === '/api/routing/eta' && req.method === 'GET') {
      if (await refusedByMapLimit(req, res)) return true;
      const { originLat, originLng, destLat, destLng, vehicleId, isOutstation, provider } = parsedUrl.query;
      if (originLat == null || originLng == null || destLat == null || destLng == null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'originLat, originLng, destLat, destLng are required' }));
        return true;
      }

      let route;
      try {
        route = await mapEngine.routing.calculateRoute(
          parseFloat(originLat),
          parseFloat(originLng),
          parseFloat(destLat),
          parseFloat(destLng),
          [],
          { vehicleId, isOutstation: isOutstation === 'true', provider }
        );
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        origin: { lat: parseFloat(originLat), lng: parseFloat(originLng) },
        destination: { lat: parseFloat(destLat), lng: parseFloat(destLng) },
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
        vehicleId: vehicleId || 'DEFAULT',
        provider: route.provider,
        routeQuality: route.routeQuality,
        isDegraded: Boolean(route.isDegraded),
        cached: route.cached
      }));
      return true;
    }

    // Routing cache statistics (admins only).
    if (pathname === '/api/routing/cache-stats' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'routing:cache-stats', requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return true;
      const stats = mapEngine.routing.getCacheStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        cacheStats: stats,
        mapEngine: mapEngine.getDiagnostics()
      }));
      return true;
    }

    // Live ETA for one trip. Object-level check: only the trip's customer, assigned driver, or an admin.
    const liveEtaMatch = pathname.match(/^\/api\/trips\/([^\/]+)\/live-eta$/);
    if (liveEtaMatch && req.method === 'GET') {
      const orderId = liveEtaMatch[1];
      if (!await enforceSecurityChecks(req, res, { routeName: 'trips:live-eta', requiredRoles: ['CUSTOMER', 'DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'], targetOrderId: orderId })) return true;
      const trip = db.getTripById(orderId);
      if (!trip) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Trip not found' }));
        return true;
      }

      let telemetry = null;
      if (trip.driver && (trip.driver.id || trip.driver.userId)) {
        const driverId = trip.driver.id || trip.driver.userId;
        telemetry = await driverLocationService.getDriverState(driverId);
      }

      const liveEta = await mapEngine.routing.calculateLiveEta(trip, telemetry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(liveEta));
      return true;
    }

    return false;
  };
}

module.exports = { createDispatchRoutes };
