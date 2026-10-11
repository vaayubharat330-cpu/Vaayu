// Driver KYC and fleet administration: driver index, KYC audit, document verification, KYC and status overrides,
// fleet owner index, and fleet driver assignment. Branch logic is moved from server_production.js. Each matched route
// answers and returns true at once, so the router stops here, including when a guard has refused the request.

function createKycFleetRoutes({ db, redisLockManager, driverLocationService, websocketService, enforceSecurityChecks, parseJsonBody }) {
  return async function handleKycFleetRoute(req, res, { pathname, parsedUrl }) {
    if (pathname === '/api/admin/drivers' && req.method === 'GET') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'] });
      if (!secPassed) return true;

      const kycFilter = (parsedUrl.query.kycStatus || parsedUrl.query.kyc || 'ALL').toUpperCase();
      const statusFilter = (parsedUrl.query.status || 'ALL').toUpperCase();
      const fleetOwnerFilter = parsedUrl.query.fleetOwnerId || null;

      const allDrivers = db.getDrivers ? db.getDrivers() : [];
      const allDocs = db.getDriverDocuments ? db.getDriverDocuments() : [];

      const enrichedDrivers = allDrivers.filter(d => {
        if (kycFilter !== 'ALL' && (d.kycStatus || 'PENDING').toUpperCase() !== kycFilter) return false;
        if (statusFilter !== 'ALL' && (d.status || 'ONLINE').toUpperCase() !== statusFilter) return false;
        if (fleetOwnerFilter && d.fleetOwnerId !== fleetOwnerFilter) return false;
        return true;
      }).map(d => {
        const driverId = d.id || d.userId;
        const docs = allDocs.filter(doc => doc.driverId === driverId || doc.driverId === d.id);
        const kycSummary = db.getKycSummary ? db.getKycSummary(driverId) : {};
        return {
          ...d,
          documents: docs,
          kycSummary
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        count: enrichedDrivers.length,
        drivers: enrichedDrivers
      }));
      return true;
    }

    if (pathname === '/api/admin/kyc-audit' && req.method === 'GET') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'] });
      if (!secPassed) return true;

      const driverId = parsedUrl.query.driverId || null;
      const statusFilter = (parsedUrl.query.status || 'ALL').toUpperCase();
      const docTypeFilter = parsedUrl.query.docType || null;

      const drivers = db.getDrivers ? db.getDrivers() : [];
      let docs = db.getDriverDocuments ? db.getDriverDocuments(driverId) : [];

      if (statusFilter !== 'ALL') {
        docs = docs.filter(d => (d.status || 'VERIFIED').toUpperCase() === statusFilter);
      }
      if (docTypeFilter) {
        docs = docs.filter(d => d.docType === docTypeFilter);
      }

      const summary = {
        totalDrivers: drivers.length,
        kycApprovedCount: drivers.filter(d => d.kycStatus === 'APPROVED').length,
        kycPendingCount: drivers.filter(d => d.kycStatus === 'PENDING' || !d.kycStatus).length,
        kycRejectedCount: drivers.filter(d => d.kycStatus === 'REJECTED' || d.kycStatus === 'ACTION_REQUIRED').length,
        totalDocuments: docs.length
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        summary,
        documents: docs,
        drivers
      }));
      return true;
    }

    if (pathname === '/api/admin/kyc/verify-doc' && req.method === 'POST') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] });
      if (!secPassed) return true;

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const { docId, driverId, action, notes, rejectionReason } = data;

        if ((!docId && (!driverId || !data.docType)) || !action) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'docId (or driverId + docType) and action are required' }));
        }

        const validActions = ['APPROVED', 'VERIFIED', 'REJECTED', 'ACTION_REQUIRED'];
        if (!validActions.includes(action.toUpperCase())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Invalid action. Must be one of: ${validActions.join(', ')}` }));
        }

        const allDocs = db.getDriverDocuments ? db.getDriverDocuments() : [];
        let targetDoc = allDocs.find(d => d.id === docId || (d.driverId === driverId && d.docType === data.docType));

        if (!targetDoc && docId) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Document ${docId} not found` }));
        }

        const statusVal = action.toUpperCase() === 'APPROVED' ? 'VERIFIED' : action.toUpperCase();
        const updatedDoc = db.updateDriverDocument ? db.updateDriverDocument(targetDoc ? targetDoc.id : docId, {
          status: statusVal,
          notes: notes || rejectionReason || '',
          verifiedBy: req.user.id
        }) : (targetDoc || {});

        // Recalculate driver's overall KYC status based on document compliance
        const effDriverId = targetDoc ? targetDoc.driverId : (driverId || null);
        const driverDocs = db.getDriverDocuments ? db.getDriverDocuments(effDriverId) : [];
        const hasRejected = driverDocs.some(d => d.status === 'REJECTED' || d.status === 'ACTION_REQUIRED');
        const allVerified = driverDocs.length > 0 && driverDocs.every(d => d.status === 'VERIFIED' || d.status === 'APPROVED');

        let newDriverKycStatus = 'PENDING';
        if (hasRejected) newDriverKycStatus = 'ACTION_REQUIRED';
        else if (allVerified) newDriverKycStatus = 'APPROVED';

        const updatedDriver = db.updateDriverKyc ? db.updateDriverKyc(effDriverId, newDriverKycStatus) : null;
        db.updateKycStep ? db.updateKycStep(effDriverId, allVerified ? 4 : 2, newDriverKycStatus, updatedDriver ? updatedDriver.name : 'Driver') : null;

        // WebSocket & Pub/Sub Broadcast
        websocketService.broadcastToRoom('admin:control_tower', 'operator_action', { action: 'VERIFY_DOCUMENT', docId: targetDoc ? targetDoc.id : docId, status: statusVal, driverId: effDriverId, operatorId: req.user.id });
        websocketService.broadcastToRoom('fleet:all', 'kyc_updated', { driverId: effDriverId, kycStatus: newDriverKycStatus, verifiedBy: req.user.id });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: `Document ${targetDoc ? targetDoc.id : docId} verified as ${statusVal}`,
          document: updatedDoc || targetDoc,
          driverKycStatus: newDriverKycStatus
        }));
      });
      return true;
    }

    if (pathname === '/api/admin/drivers/create' && req.method === 'POST') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN'] });
      if (!secPassed) return true;

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const name = String(data.name || '').trim();
        const vehicleId = String(data.vehicleId || '').trim();
        const vehicleExists = (db.getVehicles ? db.getVehicles() : []).some(v => v.id === vehicleId);
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Driver name is required.' }));
        }
        if (!vehicleExists) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'A valid vehicleId is required.' }));
        }

        const result = db.createDriverProfile({
          name,
          phone: data.phone,
          vehicleId,
          vehicleNumber: data.vehicleNumber,
          licenseNumber: data.licenseNumber,
          fleetOwnerId: data.fleetOwnerId,
          city: data.city,
          email: data.email
        });
        if (!result.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(result));
        }

        if (!result.driver.auditTrail) result.driver.auditTrail = [];
        result.driver.auditTrail.push({
          timestamp: new Date().toISOString(),
          action: 'AUDIT_ADMIN_DRIVER_CREATE',
          operatorId: req.user.id
        });
        websocketService.broadcastToRoom('admin:control_tower', 'operator_action', { action: 'CREATE_DRIVER', driverId: result.driver.id, operatorId: req.user.id });

        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: 'Driver created. Approve KYC before the driver can go online.',
          driver: result.driver
        }));
      });
      return true;
    }

    if (pathname === '/api/admin/drivers/update-kyc' && req.method === 'POST') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] });
      if (!secPassed) return true;

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const { driverId, kycStatus, notes } = data;

        if (!driverId || !kycStatus) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'driverId and kycStatus are required' }));
        }

        const updatedDriver = db.updateDriverKyc ? db.updateDriverKyc(driverId, kycStatus.toUpperCase()) : null;
        if (!updatedDriver) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Driver ${driverId} not found` }));
        }

        updatedDriver.kycNotes = notes || '';
        updatedDriver.kycVerifiedBy = req.user.id;
        updatedDriver.kycVerifiedAt = new Date().toISOString();

        if (!updatedDriver.auditTrail) updatedDriver.auditTrail = [];
        updatedDriver.auditTrail.push({
          timestamp: new Date().toISOString(),
          action: 'AUDIT_ADMIN_KYC_UPDATE',
          operatorId: req.user.id,
          operatorRole: req.user.role,
          newKycStatus: kycStatus.toUpperCase(),
          notes: notes || 'Manual KYC status override'
        });

        db.updateKycStep ? db.updateKycStep(driverId, kycStatus.toUpperCase() === 'APPROVED' ? 4 : 2, kycStatus.toUpperCase(), updatedDriver.name) : null;

        // WebSocket & Pub/Sub Broadcast
        websocketService.broadcastToRoom('admin:control_tower', 'operator_action', { action: 'UPDATE_DRIVER_KYC', driverId, kycStatus: kycStatus.toUpperCase(), operatorId: req.user.id });
        websocketService.broadcastToRoom('fleet:all', 'kyc_updated', { driverId, kycStatus: kycStatus.toUpperCase(), operatorId: req.user.id });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: `Driver ${driverId} KYC status updated to ${kycStatus.toUpperCase()}`,
          driver: updatedDriver
        }));
      });
      return true;
    }

    if (pathname === '/api/admin/drivers/update-status' && req.method === 'POST') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] });
      if (!secPassed) return true;

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const { driverId, status, reason } = data;

        if (!driverId || !status) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'driverId and status are required' }));
        }

        const statusVal = status.toUpperCase();
        const updatedDriver = db.updateDriverStatus ? db.updateDriverStatus(driverId, statusVal) : null;
        if (!updatedDriver) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Driver ${driverId} not found` }));
        }

        // If suspended or blocked, update driver telemetry liveness to OFFLINE and release active Redis locks
        if (statusVal === 'SUSPENDED' || statusVal === 'BLOCKED' || statusVal === 'OFFLINE') {
          driverLocationService.setDriverDutyStatus ? driverLocationService.setDriverDutyStatus(driverId, false) : null;
          const currentLock = await redisLockManager.getDriverLock(driverId);
          if (currentLock) {
            await redisLockManager.releaseDriverLock(driverId, currentLock.reservationId || currentLock.orderId);
          }
        }

        if (!updatedDriver.auditTrail) updatedDriver.auditTrail = [];
        updatedDriver.auditTrail.push({
          timestamp: new Date().toISOString(),
          action: 'AUDIT_ADMIN_DRIVER_STATUS_CHANGE',
          operatorId: req.user.id,
          operatorRole: req.user.role,
          newStatus: statusVal,
          reason: reason || 'Operational account status override'
        });

        // WebSocket & Pub/Sub Broadcast
        websocketService.broadcastToRoom('admin:control_tower', 'operator_action', { action: 'UPDATE_DRIVER_STATUS', driverId, status: statusVal, operatorId: req.user.id });
        websocketService.broadcastToRoom(`driver:${driverId}`, 'account_status_changed', { status: statusVal, reason: reason || 'Updated by Operations' });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: `Driver ${driverId} status updated to ${statusVal}`,
          driver: updatedDriver
        }));
      });
      return true;
    }

    if (pathname === '/api/admin/fleet-owners' && req.method === 'GET') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'] });
      if (!secPassed) return true;

      const owners = db.getFleetOwners ? db.getFleetOwners() : [];
      const allDrivers = db.getDrivers ? db.getDrivers() : [];
      const allTrips = db.getTrips ? db.getTrips() : [];

      const enrichedOwners = owners.map(o => {
        const fleetDrivers = allDrivers.filter(d => d.fleetOwnerId === o.id);
        const fleetDriverIds = new Set(fleetDrivers.map(d => d.id || d.userId));
        const activeTrips = allTrips.filter(t => {
          if (t.status === 'DELIVERED' || t.status === 'CANCELLED' || t.status === 'FAILED') return false;
          return t.driver && fleetDriverIds.has(t.driver.id || t.driver.userId);
        });
        const approvedCount = fleetDrivers.filter(d => d.kycStatus === 'APPROVED').length;
        const kycCompliancePercent = fleetDrivers.length > 0 ? Math.round((approvedCount / fleetDrivers.length) * 100) : 100;

        return {
          ...o,
          totalVehicles: fleetDrivers.length || o.totalVehicles || 0,
          totalDrivers: fleetDrivers.length || o.totalDrivers || 0,
          drivers: fleetDrivers,
          activeTrips,
          kycCompliancePercent
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        count: enrichedOwners.length,
        fleetOwners: enrichedOwners
      }));
      return true;
    }

    if (pathname === '/api/admin/fleet/assign-driver' && req.method === 'POST') {
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'] });
      if (!secPassed) return true;

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const { driverId, fleetOwnerId, vehicleId, vehicleNumber } = data;

        if (!driverId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'driverId is required' }));
        }

        const allDrivers = db.getDrivers ? db.getDrivers() : [];
        const driver = allDrivers.find(d => d.id === driverId || d.userId === driverId);

        if (!driver) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Driver ${driverId} not found` }));
        }

        if (fleetOwnerId !== undefined) driver.fleetOwnerId = fleetOwnerId;
        if (vehicleId) driver.vehicleId = vehicleId;
        if (vehicleNumber) driver.vehicleNumber = vehicleNumber;

        if (!driver.auditTrail) driver.auditTrail = [];
        driver.auditTrail.push({
          timestamp: new Date().toISOString(),
          action: 'AUDIT_ADMIN_FLEET_ASSIGN',
          operatorId: req.user.id,
          operatorRole: req.user.role,
          fleetOwnerId: fleetOwnerId || driver.fleetOwnerId,
          vehicleId: vehicleId || driver.vehicleId,
          vehicleNumber: vehicleNumber || driver.vehicleNumber
        });

        const dbData = db.getDb();
        db.saveDb(dbData);

        // WebSocket & Pub/Sub Broadcast
        websocketService.broadcastToRoom('admin:control_tower', 'operator_action', { action: 'ASSIGN_DRIVER_FLEET', driverId, fleetOwnerId, operatorId: req.user.id });
        websocketService.broadcastToRoom('fleet:all', 'fleet_updated', { driverId, fleetOwnerId });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: `Driver ${driverId} assigned to fleet owner ${fleetOwnerId || 'independent'}`,
          driver
        }));
      });
      return true;
    }

    return false;
  };
}

module.exports = { createKycFleetRoutes };
