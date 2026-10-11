/**
 * VAAYU Enterprise Logistics Platform
 * Multi-Portal Context & Request Disambiguation Service
 *
 * Identifies, validates, and tags incoming HTTP requests with portal context
 * to seamlessly distinguish between Customer App, B2B Merchant Portal,
 * Operations Control Tower, and Driver Partner interfaces.
 */

const { logger } = require('./logger');

class PortalContextService {
  /**
   * Recognized Portal Definitions
   */
  static PORTALS = {
    MERCHANT_PORTAL: {
      id: 'MERCHANT_PORTAL',
      name: 'Vaayu B2B Enterprise Merchant Portal',
      defaultChannel: 'B2B_WEB',
      allowedRoles: ['MERCHANT', 'ADMIN', 'FLEET_ADMIN']
    },
    CUSTOMER_APP: {
      id: 'CUSTOMER_APP',
      name: 'Vaayu Customer On-Demand App',
      defaultChannel: 'CUSTOMER_WEB_MOBILE',
      allowedRoles: ['CUSTOMER', 'ADMIN']
    },
    CONTROL_TOWER: {
      id: 'CONTROL_TOWER',
      name: 'Vaayu Operations Control Tower',
      defaultChannel: 'OPERATIONS_CONSOLE',
      allowedRoles: ['ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_OPERATOR']
    },
    DRIVER_APP: {
      id: 'DRIVER_APP',
      name: 'Vaayu Driver Partner App',
      defaultChannel: 'DRIVER_MOBILE',
      allowedRoles: ['DRIVER', 'ADMIN']
    }
  };

  /**
   * Extract or deduce portal context from request headers, path, and auth user role
   * @param {Object} req - HTTP request object
   * @returns {Object} portalContext
   */
  extractPortalContext(req) {
    if (!req) return null;

    const headers = req.headers || {};
    const urlPath = req.url || '';
    const userRole = (req.user && req.user.role) ? req.user.role : null;

    // 1. Explicit Client Portal Header (Highest Priority)
    const headerPortal = (headers['x-client-portal'] || headers['X-Client-Portal'] || '').toUpperCase().trim();
    
    let detectedPortalId = null;

    if (headerPortal) {
      if (headerPortal.includes('MERCHANT') || headerPortal.includes('B2B')) {
        detectedPortalId = 'MERCHANT_PORTAL';
      } else if (headerPortal.includes('CONTROL') || headerPortal.includes('ADMIN') || headerPortal.includes('TOWER')) {
        detectedPortalId = 'CONTROL_TOWER';
      } else if (headerPortal.includes('DRIVER')) {
        detectedPortalId = 'DRIVER_APP';
      } else if (headerPortal.includes('CUSTOMER') || headerPortal.includes('APP')) {
        detectedPortalId = 'CUSTOMER_APP';
      }
    }

    // 2. URL Path Hint (Second Priority)
    if (!detectedPortalId) {
      if (urlPath.includes('/api/merchant/') || urlPath.includes('/merchant')) {
        detectedPortalId = 'MERCHANT_PORTAL';
      } else if (urlPath.includes('/api/admin/') || urlPath.includes('/api/control-tower/')) {
        detectedPortalId = 'CONTROL_TOWER';
      } else if (urlPath.includes('/api/driver/')) {
        detectedPortalId = 'DRIVER_APP';
      } else if (urlPath.includes('/api/customer/') || urlPath.includes('/api/trips/')) {
        detectedPortalId = 'CUSTOMER_APP';
      }
    }

    // 3. User Role Fallback (Third Priority)
    if (!detectedPortalId && userRole) {
      if (userRole === 'MERCHANT') detectedPortalId = 'MERCHANT_PORTAL';
      else if (userRole === 'DRIVER') detectedPortalId = 'DRIVER_APP';
      else if (userRole.includes('ADMIN') || userRole.includes('DISPATCH')) detectedPortalId = 'CONTROL_TOWER';
      else detectedPortalId = 'CUSTOMER_APP';
    }

    // Default Fallback
    if (!detectedPortalId) {
      detectedPortalId = 'CUSTOMER_APP';
    }

    const portalConfig = PortalContextService.PORTALS[detectedPortalId] || PortalContextService.PORTALS.CUSTOMER_APP;

    const channel = headers['x-client-channel'] || portalConfig.defaultChannel;
    const clientVersion = headers['x-client-version'] || '1.0.0-prod';
    const correlationId = headers['x-correlation-id'] || req.requestId || `corr_${Date.now()}`;

    const context = {
      portalId: portalConfig.id,
      portalName: portalConfig.name,
      channel,
      clientVersion,
      correlationId,
      requestId: req.requestId || `req_${Date.now()}`,
      userAgent: headers['user-agent'] || 'unknown',
      origin: headers['origin'] || headers['referer'] || 'direct',
      timestamp: new Date().toISOString()
    };

    req.portalContext = context;
    return context;
  }

  /**
   * Enforce Portal Guard - Rejects request if originating portal is not allowed
   * @param {Object} req 
   * @param {Object} res 
   * @param {Array<string>} allowedPortals 
   * @returns {boolean} true if permitted, false if blocked
   */
  enforcePortalGuard(req, res, allowedPortals = []) {
    const context = req.portalContext || this.extractPortalContext(req);
    
    if (allowedPortals.length > 0 && !allowedPortals.includes(context.portalId)) {
      logger.warn('portal_guard_blocked', `Portal ${context.portalId} attempted access to guarded route`, {
        portalId: context.portalId,
        url: req.url,
        allowedPortals
      });

      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: {
          code: 'ERR_PORTAL_MISMATCH',
          message: `Endpoint restricted. Originating portal [${context.portalId}] is not authorized for this API route. Allowed portals: ${allowedPortals.join(', ')}`,
          portalContext: context
        }
      }));
      return false;
    }

    return true;
  }
}

const portalContextService = new PortalContextService();

module.exports = {
  PortalContextService,
  portalContextService
};
