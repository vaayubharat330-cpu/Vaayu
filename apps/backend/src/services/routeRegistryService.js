/**
 * VAAYU Enterprise Logistics Platform
 * Unified Route Registry & Versioned API Gateway Service
 *
 * Catalogues all enterprise API endpoints, maps legacy routes to /api/v1/... equivalents,
 * enforces portal disambiguation rules, and provides runtime introspection.
 */

class RouteRegistryService {
  constructor() {
    this.routes = new Map();
    this.versionAliasMap = new Map();
    this.initDefaultRoutes();
  }

  /**
   * Register default platform endpoints into unified registry
   */
  initDefaultRoutes() {
    const routeDefinitions = [
      // Authentication & Onboarding
      { path: '/api/auth/send-otp', method: 'POST', portal: 'ALL', role: 'PUBLIC', name: 'Send Mobile OTP' },
      { path: '/api/auth/verify-otp', method: 'POST', portal: 'ALL', role: 'PUBLIC', name: 'Verify OTP & Issue JWT' },
      { path: '/api/admin/login', method: 'POST', portal: 'CONTROL_TOWER', role: 'PUBLIC', name: 'Admin / Dispatcher Login' },

      // B2B Merchant Portal Endpoints
      { path: '/api/merchant/register', method: 'POST', portal: 'MERCHANT_PORTAL', role: 'MERCHANT', name: 'Register Business Account' },
      { path: '/api/merchant/profile', method: 'GET', portal: 'MERCHANT_PORTAL', role: 'MERCHANT', name: 'Get Merchant Profile & Credit' },
      { path: '/api/merchant/batch-booking', method: 'POST', portal: 'MERCHANT_PORTAL', role: 'MERCHANT', name: 'Multi-Vehicle Batch Dispatcher' },
      { path: '/api/merchant/parse-csv', method: 'POST', portal: 'MERCHANT_PORTAL', role: 'MERCHANT', name: 'Bulk Order CSV Parser' },
      { path: '/api/merchant/schedules', method: 'GET', portal: 'MERCHANT_PORTAL', role: 'MERCHANT', name: 'Get Recurring Schedules' },
      { path: '/api/merchant/schedules', method: 'POST', portal: 'MERCHANT_PORTAL', role: 'MERCHANT', name: 'Create Recurring Schedule' },
      { path: '/api/merchant/schedules/cancel', method: 'POST', portal: 'MERCHANT_PORTAL', role: 'MERCHANT', name: 'Cancel Recurring Schedule' },
      { path: '/api/merchant/export/orders', method: 'GET', portal: 'MERCHANT_PORTAL', role: 'MERCHANT', name: 'Export Monthly Deliveries CSV' },
      { path: '/api/merchant/calculate-savings', method: 'GET', portal: 'MERCHANT_PORTAL', role: 'PUBLIC', name: 'ROI Cost Savings Calculator' },
      { path: '/api/merchant/sla-metrics', method: 'GET', portal: 'MERCHANT_PORTAL', role: 'MERCHANT', name: 'Enterprise SLA Performance Scorecard' },

      // Customer On-Demand App Endpoints
      { path: '/api/trips/estimate', method: 'POST', portal: 'CUSTOMER_APP', role: 'PUBLIC', name: 'Calculate Multi-Vehicle Fare Estimate' },
      { path: '/api/trips/create', method: 'POST', portal: 'CUSTOMER_APP', role: 'CUSTOMER', name: 'Create Delivery Booking' },
      { path: '/api/trips/details', method: 'GET', portal: 'CUSTOMER_APP', role: 'CUSTOMER', name: 'Get Order & Tracking Details' },
      { path: '/api/trips/cancel', method: 'POST', portal: 'CUSTOMER_APP', role: 'CUSTOMER', name: 'Cancel Active Delivery' },
      { path: '/api/trips/history', method: 'GET', portal: 'CUSTOMER_APP', role: 'CUSTOMER', name: 'Customer Trip History' },

      // Operations Control Tower Endpoints
      { path: '/api/admin/fleet/live', method: 'GET', portal: 'CONTROL_TOWER', role: 'ADMIN', name: 'Live Fleet Telemetry Map' },
      { path: '/api/admin/trips/active', method: 'GET', portal: 'CONTROL_TOWER', role: 'ADMIN', name: 'Active Deliveries Monitor' },
      { path: '/api/admin/dispatch/assign', method: 'POST', portal: 'CONTROL_TOWER', role: 'ADMIN', name: 'Manual Driver Assignment Override' },
      { path: '/api/admin/dispatch/redispatch', method: 'POST', portal: 'CONTROL_TOWER', role: 'ADMIN', name: 'Force Re-Dispatch & Decline Reset' },
      { path: '/api/admin/dispatch/cancel-override', method: 'POST', portal: 'CONTROL_TOWER', role: 'ADMIN', name: 'Operational Cancel Override' },
      { path: '/api/admin/drivers/kyc/verify', method: 'POST', portal: 'CONTROL_TOWER', role: 'ADMIN', name: 'Approve/Reject Driver KYC' },
      { path: '/api/admin/sla-analytics', method: 'GET', portal: 'CONTROL_TOWER', role: 'ADMIN', name: 'Global Platform SLA Analytics' },
      { path: '/api/admin/sla-breaches', method: 'GET', portal: 'CONTROL_TOWER', role: 'ADMIN', name: 'Live SLA Breach Alerts Feed' },

      // Driver Partner App Endpoints
      { path: '/api/driver/status', method: 'POST', portal: 'DRIVER_APP', role: 'DRIVER', name: 'Toggle Duty Status (ONLINE/OFFLINE)' },
      { path: '/api/driver/location/update', method: 'POST', portal: 'DRIVER_APP', role: 'DRIVER', name: 'Sync GPS Telemetry Ping' },
      { path: '/api/dispatch/match', method: 'POST', portal: 'DRIVER_APP', role: 'DRIVER', name: 'Accept Dispatch Offer' },
      { path: '/api/dispatch/decline', method: 'POST', portal: 'DRIVER_APP', role: 'DRIVER', name: 'Decline Dispatch Offer' },
      { path: '/api/trips/state', method: 'POST', portal: 'DRIVER_APP', role: 'DRIVER', name: 'Transition Trip State (OTP Verification)' }
    ];

    routeDefinitions.forEach(route => {
      const key = `${route.method}:${route.path}`;
      this.routes.set(key, route);

      // Register /api/v1/... alias mapping
      if (route.path.startsWith('/api/')) {
        const v1Path = route.path.replace('/api/', '/api/v1/');
        this.versionAliasMap.set(v1Path, route.path);
      }
    });
  }

  /**
   * Resolve incoming request path, supporting /api/v1/ aliases
   * @param {string} pathname 
   * @returns {string} normalized internal route path
   */
  resolvePath(pathname) {
    if (!pathname) return '';
    if (this.versionAliasMap.has(pathname)) {
      return this.versionAliasMap.get(pathname);
    }
    return pathname;
  }

  /**
   * Introspect route registry metadata
   * @returns {Array<Object>} list of registered routes
   */
  getRegisteredRoutes() {
    const list = [];
    this.routes.forEach(route => {
      list.push({
        name: route.name,
        method: route.method,
        path: route.path,
        v1Path: route.path.replace('/api/', '/api/v1/'),
        targetPortal: route.portal,
        requiredRole: route.role
      });
    });
    return list;
  }
}

const routeRegistryService = new RouteRegistryService();

module.exports = {
  RouteRegistryService,
  routeRegistryService
};
