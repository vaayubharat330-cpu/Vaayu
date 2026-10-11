// Vehicle breakdown signal and emergency replacement dispatch. Each matched route answers and returns true at once, so
// the router stops here, including when a guard has refused the request.
// Breakdown signal: only the trip's assigned driver, or an operator role, may raise one. Anyone else gets 403.

const { validateFields, isLatitude, isLongitude } = require('./helpers');

const OPERATOR_ROLES = ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'];

function createBreakdownRoutes({ db, redisLockManager, websocketService, enforceSecurityChecks, parseJsonBody }) {
  return async function handleBreakdownRoute(req, res, { pathname }) {
    if (pathname === '/api/trip/breakdown-signal' && req.method === 'POST') {
      if (!await enforceSecurityChecks(req, res, { routeName: 'trip:breakdown-signal', requiredRoles: [...OPERATOR_ROLES, 'DRIVER'] })) return true;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const { tripId, driverId, lat, lng, reason, photoUrl } = data;
        if (!validateFields(res, [
          [isLatitude(lat), 'lat must be a valid latitude'],
          [isLongitude(lng), 'lng must be a valid longitude'],
        ])) return;

        const orderId = tripId;
        const trip = orderId && db.getTripById ? db.getTripById(orderId) : null;
        if (!trip) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Trip not found.' }));
        }

        if (!OPERATOR_ROLES.includes(req.user.role)) {
          const assignedDriverId = trip.driver ? (trip.driver.id || trip.driver.userId) : null;
          const callerProfile = (db.getDrivers ? db.getDrivers() : []).find(d => d.userId === req.user.id || d.id === req.user.id);
          const callerDriverId = callerProfile ? callerProfile.id : req.user.id;
          const isAssignedDriver = Boolean(assignedDriverId) && (req.user.id === assignedDriverId || callerDriverId === assignedDriverId);
          if (!isAssignedDriver) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN_OBJECT_ACCESS', message: 'Only the assigned driver or an operator can report a breakdown on this trip.' } }));
          }
        }
        const breakdownDriver = (db.getDrivers ? db.getDrivers() : []).find(d => d.id === driverId || d.userId === driverId) || null;
        {
          trip.status = 'BREAKDOWN_ALERT';
          trip.breakdownReason = reason || 'Vehicle breakdown reported';
          trip.breakdownLat = lat ?? null;
          trip.breakdownLng = lng ?? null;
          trip.breakdownPhotoUrl = photoUrl || null;
          if (!trip.auditTrail) trip.auditTrail = [];
          trip.auditTrail.push({
            timestamp: new Date().toISOString(),
            action: 'AUDIT_DRIVER_BREAKDOWN_SIGNAL',
            driverId: driverId || null,
            lat: trip.breakdownLat,
            lng: trip.breakdownLng,
            reason: trip.breakdownReason
          });
          db.saveTrip ? db.saveTrip(trip) : null;
        }

        websocketService.broadcastToRoom('admin:control_tower', 'breakdown_alert', {
          tripId: orderId,
          driverId: driverId || null,
          driverName: breakdownDriver ? breakdownDriver.name : null,
          vehicleName: breakdownDriver ? breakdownDriver.vehicleName || null : null,
          lat: lat,
          lng: lng,
          reason: reason || 'Engine failure mid-transit'
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: '🚨 Breakdown alert broadcast to Operations Control Tower! Replacement dispatch requested.',
          tripId: orderId
        }));
      });
      return true;
    }

    if (pathname === '/api/admin/dispatch/emergency-replacement' && req.method === 'POST') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] });
      if (!secPassed) return true;

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const { tripId, reason } = data;
        const orderId = tripId;
        const trip = orderId && db.getTripById ? db.getTripById(orderId) : null;
        if (!trip) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Trip not found.' }));
        }

        const brokenDriverId = (trip && trip.driver) ? (trip.driver.id || trip.driver.userId) : null;
        if (brokenDriverId) await redisLockManager.releaseDriverLock(brokenDriverId, orderId);

        const drivers = db.getDrivers ? db.getDrivers() : [];
        const replacementDriver = drivers.find(d => (d.id !== brokenDriverId && d.userId !== brokenDriverId && d.status === 'ONLINE'));
        if (!replacementDriver) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'No driver is online to take over this trip.' }));
        }

        await redisLockManager.acquireDriverLock(replacementDriver.id || replacementDriver.userId, orderId);

        if (trip) {
          trip.status = 'DRIVER_ASSIGNED';
          trip.driver = replacementDriver;
          trip.pickupAddress = `📍 BREAKDOWN TRANSFER SITE (${trip.pickupAddress || 'Pickup'})`;
          if (!trip.auditTrail) trip.auditTrail = [];
          trip.auditTrail.push({
            timestamp: new Date().toISOString(),
            action: 'AUDIT_ADMIN_EMERGENCY_REPLACEMENT_DISPATCH',
            operatorId: req.user.id,
            previousDriverId: brokenDriverId,
            replacementDriverId: replacementDriver.id || replacementDriver.userId,
            reason: reason || 'Emergency replacement dispatch for vehicle breakdown'
          });
          db.saveTrip ? db.saveTrip(trip) : null;
        }

        websocketService.broadcastToRoom('admin:control_tower', 'operator_action', {
          action: 'EMERGENCY_REPLACEMENT_DISPATCH',
          orderId,
          replacementDriverName: replacementDriver.name,
          operatorId: req.user.id
        });

        websocketService.broadcastToRoom(`driver:${replacementDriver.id || replacementDriver.userId}`, 'emergency_assignment', {
          orderId,
          message: '🚨 Emergency Replacement Cargo Transfer Assigned! Head to breakdown location.'
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: `⚡ Emergency replacement driver ${replacementDriver.name} dispatched to breakdown location!`,
          replacementDriver,
          trip
        }));
      });
      return true;
    }

    return false;
  };
}

module.exports = { createBreakdownRoutes };
