// Fleet owner vendor portal routes: profile, summary, driver list, and driver-to-vehicle assignment. Branch logic is
// moved from server_production.js unchanged. Access to /api/fleet/* is checked by the dispatcher before these run.
// Each matched route answers and returns true at once, so the router stops here.

function createFleetVendorRoutes({ db, parseJsonBody, validateFields }) {
  return async function handleFleetVendorRoute(req, res, { pathname }) {
    if (pathname === '/api/fleet/profile' && req.method === 'GET') {
      const owners = db.getFleetOwners ? db.getFleetOwners() : [];
      const fleetOwner = req.authorizedFleetOwner || owners[0];
      if (!fleetOwner) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Fleet owner not found.' })); return true; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, fleetOwner }));
      return true;
    }

    if (pathname === '/api/fleet/summary' && req.method === 'GET') {
      const owner = req.authorizedFleetOwner || (db.getFleetOwners ? db.getFleetOwners()[0] : null);
      if (!owner) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Fleet owner not found.' })); return true; }
      const drivers = (db.getDrivers ? db.getDrivers() : []).filter(driver => driver.fleetOwnerId === owner.id);
      const summary = {
        totalVehicles: Number(owner.totalVehicles) || 0,
        totalDrivers: drivers.length,
        onlineDrivers: drivers.filter(driver => driver.status === 'ONLINE').length,
        earningsToday: drivers.reduce((sum, driver) => sum + (Number(driver.todayEarnings) || 0), 0),
        totalTrips: drivers.reduce((sum, driver) => sum + (Number(driver.totalTrips) || 0), 0),
        city: owner.city || null
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, summary }));
      return true;
    }

    if (pathname === '/api/fleet/drivers' && req.method === 'GET') {
      const owner = req.authorizedFleetOwner;
      const drivers = db.getDrivers ? db.getDrivers() : [];
      const visibleDrivers = owner ? drivers.filter(driver => driver.fleetOwnerId === owner.id) : drivers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, drivers: visibleDrivers }));
      return true;
    }

    if (pathname === '/api/fleet/assign-driver' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!validateFields(res, [
          [typeof data.driver_id === 'string' && data.driver_id.trim() !== '', 'driver_id is required'],
          [typeof data.vehicle_id === 'string' && data.vehicle_id.trim() !== '', 'vehicle_id is required'],
        ])) return;
        const ownerId = req.authorizedFleetOwner ? req.authorizedFleetOwner.id : data.owner_id;
        const driver = (db.getDrivers() || []).find(item => item.id === data.driver_id || item.userId === data.driver_id);
        if (!driver || (req.authorizedFleetOwner && driver.fleetOwnerId !== ownerId)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Driver is outside this fleet.' }));
          return;
        }
        const resData = db.assignDriverToVehicle ? db.assignDriverToVehicle(ownerId, data.driver_id, data.vehicle_id) : { success: false, error: { code: 'FEATURE_UNAVAILABLE', message: 'This feature is not available on this server.' } };
        res.writeHead(resData.success ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resData));
      });
      return true;
    }

    return false;
  };
}

module.exports = { createFleetVendorRoutes };
