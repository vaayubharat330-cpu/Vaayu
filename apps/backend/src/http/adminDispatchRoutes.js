// Operator dispatch overrides: manual driver assignment, force re-dispatch with decline reset, and operational
// cancellation. Branch logic is moved from server_production.js. Each matched route answers and returns true at once, so
// the router stops here, including when a guard has refused the request. The /api/admin/ prefix is also gated upstream.

function createAdminDispatchRoutes({ db, redisLockManager, dispatchService, websocketService, deliveryStateMachine, enforceSecurityChecks, parseJsonBody }) {
  return async function handleAdminDispatchRoute(req, res, { pathname }) {
    if (pathname === '/api/admin/dispatch/assign' && req.method === 'POST') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] });
      if (!secPassed) return true;

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const { orderId, driverId, reason, force = false } = data;

        if (!orderId || !driverId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'orderId and driverId are required' }));
        }

        const trip = db.getTripById(orderId);
        if (!trip) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Trip ${orderId} not found` }));
        }

        if (trip.status === 'DELIVERED' || trip.status === 'CANCELLED' || trip.status === 'FAILED') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Cannot manually assign a completed or terminal trip in state ${trip.status}` }));
        }

        const dbDrivers = db.getDrivers ? db.getDrivers() : [];
        const driverProf = dbDrivers.find(d => d.id === driverId || d.userId === driverId);
        if (!driverProf) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Driver ${driverId} not found` }));
        }

        const targetDriverId = driverProf.id;

        // Lock safety verification.
        const currentLock = await redisLockManager.getDriverLock(targetDriverId);
        if (currentLock) {
          if (currentLock.orderId !== orderId && !force) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: false,
              error: {
                code: 'DRIVER_LOCKED',
                message: `Driver ${targetDriverId} is currently reserved by order ${currentLock.orderId}`
              }
            }));
          }
          // If the current lock belongs to this order, or force is true, release it first so acquireDriverLock (SET NX) succeeds.
          await redisLockManager.releaseDriverLock(targetDriverId, currentLock.reservationId || currentLock.orderId);
        }

        // Release the previous driver's lock if the order was assigned to a different driver.
        if (trip.driver && (trip.driver.id || trip.driver.userId) !== targetDriverId) {
          await redisLockManager.releaseDriverLock(trip.driver.id || trip.driver.userId, orderId);
        }

        // Acquire the Redis reservation lock for the target driver.
        const lockRes = await redisLockManager.acquireDriverLock(targetDriverId, orderId, 300000);

        const oldStatus = trip.status;
        trip.status = 'DRIVER_ASSIGNED';
        trip.driver = {
          id: driverProf.id,
          userId: driverProf.userId,
          name: driverProf.name,
          phone: driverProf.phone,
          vehicleName: driverProf.vehicleName,
          vehicleNumber: driverProf.vehicleNumber,
          rating: driverProf.rating || 4.8,
          lat: driverProf.currentLat || 17.4850,
          lng: driverProf.currentLng || 78.4041
        };
        trip.assignedAt = new Date().toISOString();
        trip.version = (trip.version || 1) + 1;

        if (!trip.auditTrail) trip.auditTrail = [];
        trip.auditTrail.push({
          timestamp: new Date().toISOString(),
          action: 'AUDIT_ADMIN_MANUAL_ASSIGN',
          operatorId: req.user.id,
          operatorRole: req.user.role,
          driverId: targetDriverId,
          previousStatus: oldStatus,
          newStatus: 'DRIVER_ASSIGNED',
          reason: reason || 'Operator manual driver assignment'
        });

        db.saveTrip(trip);

        // WebSocket and pub/sub broadcast.
        websocketService.broadcastToRoom('fleet:all', 'trip_assigned', { orderId, driverId: targetDriverId, assignedBy: req.user.id });
        websocketService.broadcastToRoom('admin:control_tower', 'operator_action', { action: 'MANUAL_ASSIGN', orderId, driverId: targetDriverId, operatorId: req.user.id });
        websocketService.broadcastToRoom(`driver:${targetDriverId}`, 'dispatch_offer', { tripId: orderId, trip });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: `Driver ${targetDriverId} manually assigned to trip ${orderId} by operator`,
          trip,
          reservation: lockRes
        }));
      });
      return true;
    }

    if (pathname === '/api/admin/dispatch/redispatch' && req.method === 'POST') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] });
      if (!secPassed) return true;

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const { orderId, clearDeclines = true, reason } = data;

        if (!orderId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'orderId is required' }));
        }

        const trip = db.getTripById(orderId);
        if (!trip) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Trip ${orderId} not found` }));
        }

        if (trip.status === 'DELIVERED' || trip.status === 'CANCELLED' || trip.status === 'FAILED') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Cannot re-dispatch a completed or terminal trip in state ${trip.status}` }));
        }

        // Lock safety: release the lock of the currently assigned driver, if any.
        if (trip.driver && (trip.driver.id || trip.driver.userId)) {
          await redisLockManager.releaseDriverLock(trip.driver.id || trip.driver.userId, orderId);
        }

        // Clear the decline history if requested.
        if (clearDeclines) {
          if (dispatchService && dispatchService.declinedDrivers) {
            dispatchService.declinedDrivers.delete(orderId);
          }
          await redisLockManager.redis.del(`dispatch:declined:${orderId}`);
        }

        const oldStatus = trip.status;
        trip.driver = null;
        trip.status = 'SEARCHING_DRIVER';
        trip.version = (trip.version || 1) + 1;

        if (!trip.auditTrail) trip.auditTrail = [];
        trip.auditTrail.push({
          timestamp: new Date().toISOString(),
          action: 'AUDIT_ADMIN_REDISPATCH',
          operatorId: req.user.id,
          operatorRole: req.user.role,
          clearDeclines: !!clearDeclines,
          previousStatus: oldStatus,
          newStatus: 'SEARCHING_DRIVER',
          reason: reason || 'Operator force re-dispatch'
        });

        db.saveTrip(trip);

        // Trigger the dispatch cycle.
        if (dispatchService && dispatchService.triggerDispatchCycle) {
          dispatchService.triggerDispatchCycle(orderId);
        }

        // WebSocket and pub/sub broadcast.
        websocketService.broadcastToRoom('fleet:all', 'trip_redispatched', { orderId, clearDeclines: !!clearDeclines, operatorId: req.user.id });
        websocketService.broadcastToRoom('admin:control_tower', 'operator_action', { action: 'FORCE_REDISPATCH', orderId, operatorId: req.user.id });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: `Re-dispatch initiated for trip ${orderId}. Decline history cleared: ${!!clearDeclines}.`,
          clearDeclines: !!clearDeclines,
          trip
        }));
      });
      return true;
    }

    if (pathname === '/api/admin/trips/cancel-override' && req.method === 'POST') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] });
      if (!secPassed) return true;

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const { orderId, reason } = data;

        if (!orderId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'orderId is required' }));
        }

        if (!reason || typeof reason !== 'string' || !reason.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Operator cancellation reason is mandatory' }));
        }

        const trip = db.getTripById(orderId);
        if (!trip) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Trip ${orderId} not found` }));
        }

        if (trip.status === 'DELIVERED' || trip.status === 'CANCELLED' || trip.status === 'FAILED') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Cannot cancel an already terminal trip in state ${trip.status}` }));
        }

        // Release the driver lock if assigned.
        if (trip.driver && (trip.driver.id || trip.driver.userId)) {
          await redisLockManager.releaseDriverLock(trip.driver.id || trip.driver.userId, orderId);
        }

        // Execute the state machine transition for ADMIN.
        const smResult = await deliveryStateMachine.transition(orderId, 'CANCELLED', { type: 'ADMIN', id: req.user.id }, { reason });

        const oldStatus = trip.status;
        trip.status = 'CANCELLED';
        trip.cancelledAt = new Date().toISOString();
        trip.cancellationReason = reason.trim();
        trip.cancelledBy = req.user.id;
        trip.version = (trip.version || 1) + 1;

        if (!trip.auditTrail) trip.auditTrail = [];
        trip.auditTrail.push({
          timestamp: new Date().toISOString(),
          action: 'AUDIT_ADMIN_CANCEL_OVERRIDE',
          operatorId: req.user.id,
          operatorRole: req.user.role,
          previousStatus: oldStatus,
          newStatus: 'CANCELLED',
          reason: reason.trim()
        });

        db.saveTrip(trip);

        // Broadcast WebSocket notifications.
        websocketService.broadcastToRoom('fleet:all', 'trip_cancelled', { orderId, reason: reason.trim(), cancelledBy: req.user.id });
        websocketService.broadcastToRoom('admin:control_tower', 'operator_action', { action: 'CANCEL_OVERRIDE', orderId, operatorId: req.user.id });
        if (trip.customerId) {
          websocketService.broadcastToRoom(`customer:${trip.customerId}`, 'trip_cancelled', { orderId, reason: reason.trim() });
        }
        if (trip.driver && (trip.driver.id || trip.driver.userId)) {
          websocketService.broadcastToRoom(`driver:${trip.driver.id || trip.driver.userId}`, 'trip_cancelled', { orderId, reason: reason.trim() });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: `Trip ${orderId} operationally cancelled by operator`,
          stateMachineResult: smResult,
          trip
        }));
      });
      return true;
    }

    return false;
  };
}

module.exports = { createAdminDispatchRoutes };
