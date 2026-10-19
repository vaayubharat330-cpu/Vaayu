// Operations control tower for operators: live fleet telemetry, active deliveries, unified search, and operational
// alerts. Branch logic is moved from server_production.js. Each matched route answers and returns true at once, so the
// router stops here, including when a guard has refused the request. The /api/admin/ prefix is also gated upstream.

function createAdminOpsRoutes({ db, driverLocationService, redisLockManager, mapEngine, deliveryStateMachine, enforceSecurityChecks }) {
  return async function handleAdminOpsRoute(req, res, { pathname, parsedUrl }) {
    if (pathname === '/api/admin/fleet/live' && req.method === 'GET') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'] });
      if (!secPassed) return true;

      const statusFilter = (parsedUrl.query.status || 'ALL').toUpperCase();
      const vehicleFilter = parsedUrl.query.vehicleId || null;
      const zoneFilter = (parsedUrl.query.zone || '').toLowerCase();

      const dbDrivers = db.getDrivers ? db.getDrivers() : [];
      const fleetMap = [];

      let onlineCount = 0;
      let degradedCount = 0;
      let staleCount = 0;
      let offlineCount = 0;

      for (const dProf of dbDrivers) {
        const driverId = dProf.id || dProf.userId;
        const telemetry = await driverLocationService.getDriverState(driverId);

        const hasTelemetry = Boolean(telemetry && telemetry.lastPingMs);
        const lat = hasTelemetry ? telemetry.lat : null;
        const lng = hasTelemetry ? telemetry.lng : null;
        const livenessState = hasTelemetry ? telemetry.livenessState : 'OFFLINE';
        const dutyStatus = (telemetry && telemetry.status) ? telemetry.status : dProf.status;
        const lastPingMs = hasTelemetry ? telemetry.lastPingMs : null;

        const dutyOffline = dutyStatus === 'OFFLINE';
        if (!dutyOffline && (livenessState === 'ONLINE' || livenessState === 'HEALTHY')) onlineCount++;
        if (!dutyOffline && livenessState === 'DEGRADED') degradedCount++;
        if (!dutyOffline && livenessState === 'STALE') staleCount++;
        if (livenessState === 'OFFLINE' || dutyOffline) offlineCount++;

        // Filter by liveness or duty status.
        const matchesLivenessFilter = !dutyOffline && (livenessState === statusFilter || (statusFilter === 'ONLINE' && livenessState === 'HEALTHY'));
        if (statusFilter !== 'ALL' && !matchesLivenessFilter && dutyStatus !== statusFilter) {
          continue;
        }

        // Filter by vehicle category.
        if (vehicleFilter && dProf.vehicleId !== vehicleFilter) {
          continue;
        }

        // Filter by zone or landmark string.
        if (zoneFilter && !(dProf.vehicleName || '').toLowerCase().includes(zoneFilter) && !(dProf.name || '').toLowerCase().includes(zoneFilter)) {
          // Simple location bounding box for Hyderabad zones.
          if (zoneFilter === 'kphb' && (lat < 17.47 || lat > 17.50 || lng < 78.38 || lng > 78.42)) continue;
          if (zoneFilter === 'hitec' && (lat < 17.43 || lat > 17.46 || lng < 78.33 || lng > 78.37)) continue;
        }

        // Active lock check.
        const lockInfo = await redisLockManager.getDriverLock(driverId);

        fleetMap.push({
          driverId,
          userId: dProf.userId,
          name: dProf.name,
          phone: dProf.phone,
          vehicleId: dProf.vehicleId,
          vehicleName: dProf.vehicleName,
          vehicleNumber: dProf.vehicleNumber,
          rating: dProf.rating || 4.8,
          dutyStatus,
          livenessState,
          lat,
          lng,
          bearing: hasTelemetry ? telemetry.bearing : null,
          speed: hasTelemetry ? telemetry.speed : null,
          accuracy: hasTelemetry ? telemetry.accuracy : null,
          lastPingMs,
          pingAgeSec: lastPingMs ? Math.max(0, Math.round((Date.now() - lastPingMs) / 1000)) : null,
          locationSource: hasTelemetry ? 'GPS_TELEMETRY' : 'NO_TELEMETRY',
          isReserved: Boolean(lockInfo),
          reservedOrderId: lockInfo ? lockInfo.orderId : null
        });
      }

      const totalDrivers = dbDrivers.length;
      const utilizationPercent = Math.round(((onlineCount + degradedCount) / (totalDrivers || 1)) * 100);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        summary: {
          totalDrivers,
          onlineCount,
          degradedCount,
          staleCount,
          offlineCount,
          utilizationPercent
        },
        drivers: fleetMap
      }));
      return true;
    }

    if (pathname === '/api/admin/trips/active' && req.method === 'GET') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'] });
      if (!secPassed) return true;

      const allTrips = db.getTrips ? db.getTrips() : [];
      const ACTIVE_STATES = ['CREATED', 'SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DRIVER_ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_AT_PICKUP', 'PICKUP_CONFIRMED', 'IN_TRANSIT', 'DRIVER_AT_DROPOFF'];
      const activeTrips = allTrips.filter(t => ACTIVE_STATES.includes(t.status));

      const enrichedTrips = [];
      for (const trip of activeTrips) {
        let telemetry = null;
        if (trip.driver && (trip.driver.id || trip.driver.userId)) {
          const driverId = trip.driver.id || trip.driver.userId;
          telemetry = await driverLocationService.getDriverState(driverId);
        }

        const liveEta = await mapEngine.routing.calculateLiveEta(trip, telemetry);
        const auditLogs = deliveryStateMachine.getAuditLogs(trip.id);
        const lockInfo = (trip.driver && trip.driver.id) ? await redisLockManager.getDriverLock(trip.driver.id) : null;

        enrichedTrips.push({
          ...trip,
          liveEta,
          auditCount: auditLogs.length,
          reservationLockActive: Boolean(lockInfo && lockInfo.orderId === trip.id),
          waitingTimeSec: trip.createdAt ? Math.round((Date.now() - new Date(trip.createdAt).getTime()) / 1000) : 0
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        count: enrichedTrips.length,
        activeTrips: enrichedTrips
      }));
      return true;
    }

    if (pathname === '/api/admin/search' && req.method === 'GET') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'] });
      if (!secPassed) return true;

      const q = (parsedUrl.query.q || parsedUrl.query.query || '').toLowerCase().trim();
      if (!q) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Query parameter q is required' }));
        return true;
      }

      const allTrips = db.getTrips ? db.getTrips() : [];
      const allDrivers = db.getDrivers ? db.getDrivers() : [];
      const allUsers = db.getDb().users || [];

      const matchingTrips = allTrips.filter(t =>
        t.id.toLowerCase().includes(q) ||
        (t.customerName || '').toLowerCase().includes(q) ||
        (t.customerPhone || '').includes(q) ||
        (t.pickupAddress || '').toLowerCase().includes(q) ||
        (t.dropAddress || '').toLowerCase().includes(q) ||
        (t.status || '').toLowerCase().includes(q)
      );

      const matchingDrivers = allDrivers.filter(d =>
        (d.id || '').toLowerCase().includes(q) ||
        (d.userId || '').toLowerCase().includes(q) ||
        (d.name || '').toLowerCase().includes(q) ||
        (d.phone || '').includes(q) ||
        (d.vehicleNumber || '').toLowerCase().includes(q) ||
        (d.vehicleId || '').toLowerCase().includes(q)
      );

      const matchingCustomers = allUsers.filter(u =>
        (u.role === 'CUSTOMER' || !u.role) && (
          (u.id || '').toLowerCase().includes(q) ||
          (u.name || '').toLowerCase().includes(q) ||
          (u.phone || '').includes(q)
        )
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        query: q,
        counts: {
          trips: matchingTrips.length,
          drivers: matchingDrivers.length,
          customers: matchingCustomers.length
        },
        trips: matchingTrips,
        drivers: matchingDrivers,
        customers: matchingCustomers
      }));
      return true;
    }

    if (pathname === '/api/admin/alerts' && req.method === 'GET') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'] });
      if (!secPassed) return true;

      const allTrips = db.getTrips ? db.getTrips() : [];
      const dbDrivers = db.getDrivers ? db.getDrivers() : [];
      const alerts = [];
      const now = Date.now();

      // Alert 1: unassigned dispatch delays (over 30 s in SEARCHING_DRIVER or CREATED).
      for (const trip of allTrips) {
        if (trip.status === 'SEARCHING_DRIVER' || trip.status === 'CREATED') {
          const ageSec = trip.createdAt ? Math.round((now - new Date(trip.createdAt).getTime()) / 1000) : 0;
          if (ageSec > 30) {
            alerts.push({
              id: `ALT_DISPATCH_DELAY_${trip.id}`,
              severity: ageSec > 120 ? 'CRITICAL' : 'WARNING',
              type: 'DISPATCH_TIMEOUT_DELAY',
              orderId: trip.id,
              vehicleId: trip.vehicleId,
              ageSec,
              message: `Order ${trip.id} has been waiting for driver assignment for ${ageSec}s in state ${trip.status}`,
              timestamp: new Date().toISOString()
            });
          }
        }
      }

      // Alert 2: driver telemetry staleness during an active trip.
      for (const dProf of dbDrivers) {
        const driverId = dProf.id || dProf.userId;
        const telemetry = await driverLocationService.getDriverState(driverId);
        const livenessState = (telemetry && telemetry.livenessState) ? telemetry.livenessState : 'ONLINE';

        const activeTrip = allTrips.find(t => {
          if (t.status === 'DELIVERED' || t.status === 'CANCELLED' || t.status === 'FAILED') return false;
          return t.driver && (t.driver.id === driverId || t.driver.userId === driverId);
        });

        if (activeTrip && (livenessState === 'STALE' || livenessState === 'DEGRADED' || livenessState === 'OFFLINE')) {
          alerts.push({
            id: `ALT_DRIVER_TELEMETRY_${driverId}`,
            severity: livenessState === 'OFFLINE' ? 'HIGH' : 'MEDIUM',
            type: 'TELEMETRY_SIGNAL_LOSS',
            driverId,
            driverName: dProf.name,
            orderId: activeTrip.id,
            livenessState,
            message: `Driver ${dProf.name} on active trip ${activeTrip.id} has signal state ${livenessState}`,
            timestamp: new Date().toISOString()
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        count: alerts.length,
        alerts
      }));
      return true;
    }

    return false;
  };
}

module.exports = { createAdminOpsRoutes };
