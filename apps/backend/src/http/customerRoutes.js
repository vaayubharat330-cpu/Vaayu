// Customer profile, wallet top-up (not live), trip history, single trip detail, and trip chat. Branch logic is moved
// from server_production.js. Each matched route answers and returns true at once, so the router stops here, including
// when a guard has refused the request. A method that a route does not handle falls through (returns false) as before.

function createCustomerRoutes({
  db, metricsService, driverLocationService, mapEngine, logger, deliveryStateMachine, enforceSecurityChecks, parseJsonBody
}) {
  return async function handleCustomerRoute(req, res, { pathname, parsedUrl }) {
    if (pathname === '/api/customer/profile') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'ADMIN'] });
      if (!secPassed) return true;

      if (req.method === 'GET') {
        const store = db.getDb();
        const user = (store.users || []).find(record => record.id === req.user.id) || req.user;
        if (!user) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Profile not found.' }));
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          profile: {
            id: user.id,
            name: user.name,
            phone: user.phone,
            email: user.email || `${user.phone}@vaayu.in`,
            city: user.city || 'Hyderabad',
            walletBalance: Number(user.walletBalance) || 0,
            role: user.role || 'CUSTOMER',
            createdAt: user.createdAt
          }
        }));
        return true;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const data = parseJsonBody(res, body);
          if (!data) return;

          const store = db.getDb();
          const userRec = store.users.find(u => u.id === req.user.id);
          if (userRec) {
            if (data.name) userRec.name = data.name.trim();
            if (data.email) userRec.email = data.email.trim();
            if (data.city) userRec.city = data.city.trim();
            db.saveDb(store);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            profile: userRec || req.user
          }));
        });
        return true;
      }
    }

    if (pathname === '/api/customer/wallet/top-up' && req.method === 'POST') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'customer:wallet-top-up', requiredRoles: ['CUSTOMER'] })) return true;
      // Wallet top-up needs the payment gateway, which is not live. Until it is, no balance is credited.
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Wallet top-up is not available yet. Payments are not live.' }));
      return true;
    }

    // Customer trip history, scoped to the signed-in customer.
    if (pathname === '/api/trips/history' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'] })) return true;
      const currentUser = req.user;

      const targetCustomerId = parsedUrl.query.customerId || currentUser.id;
      const statusFilter = (parsedUrl.query.status || parsedUrl.query.category || '').toUpperCase();

      // BOLA check: a customer cannot query another customer's trip history.
      if (currentUser.role === 'CUSTOMER' && targetCustomerId && currentUser.id !== targetCustomerId) {
        metricsService.increment('bola_denied_total');
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: { code: 'FORBIDDEN_OBJECT_ACCESS', message: 'Unauthorized object-level access to customer trip history' }
        }));
        return true;
      }

      const allTrips = db.getTrips ? db.getTrips() : [];
      let userTrips = targetCustomerId ? allTrips.filter(t => t.customerId === targetCustomerId) : allTrips;

      const ACTIVE_STATES = ['CREATED', 'SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_AT_PICKUP', 'PICKUP_CONFIRMED', 'IN_TRANSIT', 'DRIVER_AT_DROPOFF'];
      const activeTrips = userTrips.filter(t => ACTIVE_STATES.includes(t.status));
      const completedTrips = userTrips.filter(t => t.status === 'DELIVERED' || t.status === 'COMPLETED');
      const cancelledTrips = userTrips.filter(t => t.status === 'CANCELLED' || t.status === 'FAILED');

      let filteredTrips = userTrips;
      if (statusFilter === 'ACTIVE') filteredTrips = activeTrips;
      if (statusFilter === 'COMPLETED') filteredTrips = completedTrips;
      if (statusFilter === 'CANCELLED') filteredTrips = cancelledTrips;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        customerId: targetCustomerId,
        count: filteredTrips.length,
        activeCount: activeTrips.length,
        completedCount: completedTrips.length,
        cancelledCount: cancelledTrips.length,
        activeTrips,
        completedTrips,
        cancelledTrips,
        trips: filteredTrips
      }));
      return true;
    }

    // One trip with its live ETA and audit log.
    const singleTripMatch = pathname.match(/^\/api\/trips\/((?:TRIP_|ORD-)[^\/]+)$/);
    if (singleTripMatch && req.method === 'GET') {
      const orderId = singleTripMatch[1];
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'], targetOrderId: orderId })) return true;
      const trip = db.getTripById(orderId);
      if (!trip) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Trip not found' }));
        return true;
      }

      const secPassed = await enforceSecurityChecks(req, res, { targetOrderId: orderId });
      if (!secPassed) return true;

      let telemetry = null;
      if (trip.driver && (trip.driver.id || trip.driver.userId)) {
        const driverId = trip.driver.id || trip.driver.userId;
        telemetry = await driverLocationService.getDriverState(driverId);
      }

      let liveEta = null;
      try {
        liveEta = await mapEngine.routing.calculateLiveEta(trip, telemetry);
      } catch (etaError) {
        logger.warn('live_eta_unavailable', `Live ETA unavailable for ${orderId}: ${etaError.message}`, { orderId });
      }
      const auditLogs = deliveryStateMachine.getAuditLogs(orderId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        trip,
        liveEta,
        auditLogs
      }));
      return true;
    }

    // Trip chat between customer and driver: read messages.
    if (pathname === '/api/chat/messages' && req.method === 'GET') {
      const tripId = parsedUrl.query.tripId;
      if (!tripId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'tripId is required.' }));
        return true;
      }
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'], targetOrderId: tripId })) return true;
      if (!db.getTripById(tripId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Trip not found.' }));
        return true;
      }
      const messages = db.getTripMessages ? db.getTripMessages(tripId) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        messages
      }));
      return true;
    }

    // Trip chat: send a message.
    if (pathname === '/api/chat/send' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        const tripId = data.tripId || data.trip_id;
        if (!tripId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'tripId is required.' }));
        }
        if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'], targetOrderId: tripId })) return;
        const trip = db.getTripById(tripId);
        if (!trip) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Trip not found.' }));
        }
        const messageText = data.messageText || data.message || data.text;
        if (!messageText || !messageText.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Message cannot be empty.' }));
        }

        const userMsg = db.addTripMessage(
          tripId,
          req.user.role,
          req.user.name || req.user.username || req.user.role,
          messageText.trim()
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: userMsg
        }));
      });
      return true;
    }

    return false;
  };
}

module.exports = { createCustomerRoutes };
