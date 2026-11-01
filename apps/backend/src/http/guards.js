// Request guards: authentication, role, object-ownership checks for API routes.
// The logic is unchanged from server_production.js. Dependencies are supplied through createGuards().
const { hasRequiredRole } = require('./helpers');

function createGuards({ db, redisRateLimiter, authService, metricsService, logger }) {
  async function enforceSecurityChecks(req, res, options = {}) {
    const { routeName = 'default', requiredRoles = null, targetOrderId = null } = options;
    const rateCheck = await redisRateLimiter.checkRateLimit(req, res, routeName);
    if (rateCheck.error && process.env.NODE_ENV === 'production') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { code: 'RATE_LIMIT_UNAVAILABLE', message: 'Security rate limiting is unavailable.' } }));
      return false;
    }
    if (!rateCheck.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: rateCheck.message } }));
      return false;
    }
    const authHeader = authService.extractToken(req);
    let user = null;
    if (authHeader) {
      user = authService.verifyToken(authHeader);
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired authorization bearer token' } }));
        return false;
      }
      req.user = user;
    } else if (requiredRoles) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }));
      return false;
    }
    if (requiredRoles && user) {
      const userRole = user.role || 'CUSTOMER';
      if (!hasRequiredRole(userRole, requiredRoles)) {
        metricsService.increment('authorization_denied_total');
        logger.warn('role_authorization_denied', `Role access denied for user ${user.id} with role ${userRole}`, { userId: user.id, userRole, requiredRoles });
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN_ROLE', message: `Access denied. Role ${userRole} is not permitted for this operation.` } }));
        return false;
      }
    }
    if (targetOrderId && user) {
      const isAdminRole = ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'].includes(user.role || '');
      if (!isAdminRole) {
        const trip = db.getTripById(targetOrderId);
        let isAuthorized = false;
        if (trip && user.role === 'CUSTOMER' && trip.customerId) isAuthorized = user.id === trip.customerId;
        if (trip && user.role === 'DRIVER') {
          const assignedDriverId = trip.driver ? (trip.driver.id || trip.driver.userId) : null;
          const dbDrivers = db.getDrivers ? db.getDrivers() : [];
          const driverProf = dbDrivers.find(d => d.userId === user.id || d.id === user.id);
          const effDriverId = driverProf ? driverProf.id : user.id;
          isAuthorized = Boolean(assignedDriverId) && (user.id === assignedDriverId || effDriverId === assignedDriverId);
        }
        if (!isAuthorized) {
          metricsService.increment('bola_denied_total');
          metricsService.increment('authorization_denied_total');
          logger.warn('bola_denied', `BOLA object access denied for user ${user.id} on trip ${targetOrderId}`, { userId: user.id, orderId: targetOrderId });
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN_OBJECT_ACCESS', message: 'Unauthorized object-level access attempt (BOLA/IDOR protection)' } }));
          return false;
        }
      }
    }
    return true;
  }

  async function enforceDriverAccess(req, res, requestedDriverId = null, routeName = 'driver:private') {
    // The unauthenticated driver portal performs a harmless profile probe during bootstrap.
    // Treat the empty-id probe as "no active driver session" rather than an authorization error.
    // Any concrete driver id still follows the normal authenticated path below.
    if (routeName === 'driver:profile' && requestedDriverId == null && req.method === 'GET' && !authService.extractToken(req)) {
      req.authorizedDriverId = null;
      return true;
    }
    const allowed = await enforceSecurityChecks(req, res, { routeName, requiredRoles: ['DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'] });
    if (!allowed) return false;
    if (req.user.role === 'DRIVER') {
      const profile = (db.getDrivers() || []).find(driver => driver.userId === req.user.id || driver.id === req.user.id);
      const requested = requestedDriverId == null ? null : String(requestedDriverId);
      if (!profile || (requested && requested !== profile.id && requested !== profile.userId)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN_DRIVER_ACCESS', message: 'Driver profile access denied.' } }));
        return false;
      }
      req.authorizedDriverId = profile.id;
    } else {
      req.authorizedDriverId = requestedDriverId || null;
    }
    return true;
  }

  async function enforceMerchantAccess(req, res, requestedMerchantId = null) {
    const allowed = await enforceSecurityChecks(req, res, { routeName: 'merchant:private', requiredRoles: ['MERCHANT', 'MERCHANT_ADMIN', 'MERCHANT_DISPATCHER', 'MERCHANT_AUDITOR', 'ADMIN', 'SUPER_ADMIN'] });
    if (!allowed) return false;
    const userRole = req.user.role;
    const isEnterpriseMerchantRole = ['MERCHANT', 'MERCHANT_ADMIN', 'MERCHANT_DISPATCHER', 'MERCHANT_AUDITOR'].includes(userRole);
    if (isEnterpriseMerchantRole) {
      const userTenantId = req.user.tenantId || req.user.merchantId || req.user.id;
      if (requestedMerchantId && String(requestedMerchantId) !== String(userTenantId)) {
        metricsService.increment('tenant_cross_access_blocked_total');
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN_MERCHANT_ACCESS', message: 'Merchant account access denied.' } }));
        return false;
      }
      req.authorizedMerchantId = userTenantId;
    } else {
      req.authorizedMerchantId = requestedMerchantId || null;
    }
    return true;
  }

  async function enforceFleetOwnerAccess(req, res, requestedOwnerId = null) {
    const allowed = await enforceSecurityChecks(req, res, { routeName: 'fleet:private', requiredRoles: ['FLEET_OWNER', 'ADMIN', 'SUPER_ADMIN'] });
    if (!allowed) return false;
    if (req.user.role === 'FLEET_OWNER') {
      const owner = (db.getFleetOwners() || []).find(record => record.userId === req.user.id || record.id === req.user.id);
      if (!owner || (requestedOwnerId && requestedOwnerId !== owner.id && requestedOwnerId !== owner.userId)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN_FLEET_ACCESS', message: 'Fleet owner access denied.' } }));
        return false;
      }
      req.authorizedFleetOwner = owner;
    } else {
      req.authorizedFleetOwner = (db.getFleetOwners() || []).find(record => record.id === requestedOwnerId) || null;
    }
    return true;
  }

  async function enforceAuthRateLimit(req, res, routeName) {
    const rateCheck = await redisRateLimiter.checkRateLimit(req, res, routeName);
    if (rateCheck.error && process.env.NODE_ENV === 'production') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Security rate limiting is unavailable.' }));
      return false;
    }
    if (!rateCheck.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: rateCheck.message } }));
      return false;
    }
    return true;
  }

  return { enforceSecurityChecks, enforceDriverAccess, enforceMerchantAccess, enforceFleetOwnerAccess, enforceAuthRateLimit };
}

module.exports = { createGuards };
