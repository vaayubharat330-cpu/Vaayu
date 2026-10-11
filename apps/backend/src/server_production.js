const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const envPath = fs.existsSync(path.resolve(__dirname, '../.env'))
  ? path.resolve(__dirname, '../.env')
  : path.resolve(process.cwd(), '.env');
require('dotenv').config({ path: envPath });

if (process.env.NODE_ENV === 'production') {
  const hasDurableDb = (process.env.DATABASE_URL || '').startsWith('postgresql://') || String(process.env.PERSISTENCE_PROVIDER || '').toLowerCase() === 'postgres';
  const hasJwtSecret = typeof process.env.JWT_SECRET === 'string' && process.env.JWT_SECRET.length >= 32;
  if (!hasDurableDb) {
    throw new Error('Production startup requires DATABASE_URL=postgresql://... and PERSISTENCE_PROVIDER=postgres (Prisma + Postgres). Set DATABASE_URL to your managed Postgres before deploying.');
  }
  if (!hasJwtSecret) {
    throw new Error('Production startup requires JWT_SECRET >= 32 chars. Set a strong random secret in .env.');
  }
  if (!process.env.VAAYU_ADMIN_USERS_JSON) {
    throw new Error('Production startup requires VAAYU_ADMIN_USERS_JSON. Seeded local admin passwords are not allowed in production.');
  }
}

const {
  ADMIN_ROLE_GRANTS,
  ADMIN_PERMISSIONS,
  hasRequiredRole,
  csvCell,
  configuredAdminUsers,
  sendCompressedJsonResponse,
  createTextPdf,
  parseJsonBody,
  validateFields,
  isLatitude,
  isLongitude
} = require('./http/helpers');
const db = require('./db/database');
const { calculateFareEstimates } = require('./services/fareService');
const { mapEngine } = require('./map-engine');
const { driverLocationService } = require('./services/driverLocationService');
const { websocketService } = require('./services/websocketService');
const { deliveryStateMachine, DELIVERY_STATES } = require('./services/deliveryStateMachine');
const { dispatchService } = require('./services/dispatchService');
const { authService } = require('./services/authService');
const { redisRateLimiter } = require('./services/redisRateLimiter');
const { idempotencyService } = require('./services/idempotencyService');
const { metricsService } = require('./services/metricsService');
const { logger } = require('./services/logger');
const { fareQuoteProvider } = require('./services/fareQuoteProvider');
const { paymentProvider } = require('./services/paymentProvider');
const { documentOcrProvider } = require('./services/documentOcrProvider');
const { notificationProvider } = require('./services/notificationProvider');
const { redisLockManager } = require('./services/redisLockManager');
const { geoCache, fareCache } = require('./services/lruCacheService');
const { orderIdService } = require('./services/orderIdService');
const { PortalContextService, portalContextService } = require('./services/portalContextService');
const { routeRegistryService } = require('./services/routeRegistryService');
const { slaService } = require('./services/slaService');
const { schemaValidationService } = require('./services/schemaValidationService');
const { circuitBreakerService } = require('./services/circuitBreakerService');
const { otpService } = require('./services/otpService');
const { otpChallenges, OtpError } = require('./services/otpChallengeService');
const { createGuards } = require('./http/guards');
const { createOpsRoutes } = require('./http/opsRoutes');
const { createAuthRoutes } = require('./http/authRoutes');
const { createCatalogRoutes } = require('./http/catalogRoutes');
const { createDriverRegistrationRoutes } = require('./http/driverRegistrationRoutes');
const { createGeocodingRoutes } = require('./http/geocodingRoutes');
const { createDriverTelemetryRoutes } = require('./http/driverTelemetryRoutes');
const { createTripBookingRoutes } = require('./http/tripBookingRoutes');
const { createDispatchRoutes } = require('./http/dispatchRoutes');
const { createOrderRoutes } = require('./http/orderRoutes');
const { createProofRoutes } = require('./http/proofRoutes');
const { createCustomerRoutes } = require('./http/customerRoutes');
const { createAdminAuthRoutes } = require('./http/adminAuthRoutes');
const { createAdminOpsRoutes } = require('./http/adminOpsRoutes');
const { createAdminDispatchRoutes } = require('./http/adminDispatchRoutes');
const { createBreakdownRoutes } = require('./http/breakdownRoutes');
const { createTrackingRoutes } = require('./http/trackingRoutes');
const { createKycFleetRoutes } = require('./http/kycFleetRoutes');
const { createAdminContentRoutes } = require('./http/adminContentRoutes');
const { createDriverPartnerRoutes } = require('./http/driverPartnerRoutes');
const { createAdminCancellationRoutes } = require('./http/adminCancellationRoutes');
const { createPaymentRoutes } = require('./http/paymentRoutes');
const { createRadarRoutes } = require('./http/radarRoutes');
const { createMerchantRoutes } = require('./http/merchantRoutes');
const { createMerchantBatchRoutes } = require('./http/merchantBatchRoutes');
const { createFleetVendorRoutes } = require('./http/fleetVendorRoutes');
const { createSafetyRoutes } = require('./http/safetyRoutes');
const { createSupportRoutes } = require('./http/supportRoutes');
const handleOpsRoute = createOpsRoutes({ db, redisRateLimiter, websocketService, routeRegistryService, PortalContextService, circuitBreakerService, metricsService });
const { enforceSecurityChecks, enforceDriverAccess, enforceMerchantAccess, enforceFleetOwnerAccess, enforceAuthRateLimit } = createGuards({ db, redisRateLimiter, authService, metricsService, logger });
const handleAuthRoute = createAuthRoutes({ db, otpChallenges, OtpError, authService, logger, parseJsonBody, enforceAuthRateLimit });
const handleCatalogRoute = createCatalogRoutes({ db });
const handleDriverRegistrationRoute = createDriverRegistrationRoutes({ db, otpChallenges, OtpError, redisRateLimiter, parseJsonBody });
const handleGeocodingRoute = createGeocodingRoutes({ mapEngine, redisRateLimiter });
const handleDriverTelemetryRoute = createDriverTelemetryRoutes({ db, driverLocationService, websocketService, enforceDriverAccess, enforceSecurityChecks, parseJsonBody, validateFields });
const handleTripBookingRoute = createTripBookingRoutes({ db, fareQuoteProvider, isAdminFeatureEnabled, idempotencyService, paymentProvider, otpService, orderIdService, portalContextService, metricsService, logger, dispatchService, DELIVERY_STATES, parseJsonBody, validateFields, isLatitude, isLongitude, enforceSecurityChecks, crypto, redisRateLimiter });
const handleDispatchRoute = createDispatchRoutes({ db, dispatchService, mapEngine, driverLocationService, enforceSecurityChecks, enforceDriverAccess, parseJsonBody, redisRateLimiter });
const handleOrderRoute = createOrderRoutes({ db, deliveryStateMachine, redisLockManager, otpService, paymentProvider, idempotencyService, dispatchService, driverLocationService, DELIVERY_STATES, enforceSecurityChecks, parseJsonBody });
const handleCustomerRoute = createCustomerRoutes({ db, metricsService, driverLocationService, mapEngine, logger, deliveryStateMachine, enforceSecurityChecks, parseJsonBody });
const handleAdminAuthRoute = createAdminAuthRoutes({ redisRateLimiter, parseJsonBody, configuredAdminUsers, ADMIN_PERMISSIONS, authService, otpChallenges, crypto });
const handleAdminOpsRoute = createAdminOpsRoutes({ db, driverLocationService, redisLockManager, mapEngine, deliveryStateMachine, enforceSecurityChecks });
const handleAdminDispatchRoute = createAdminDispatchRoutes({ db, redisLockManager, dispatchService, websocketService, deliveryStateMachine, enforceSecurityChecks, parseJsonBody });
const handleBreakdownRoute = createBreakdownRoutes({ db, redisLockManager, websocketService, enforceSecurityChecks, parseJsonBody });
const handleTrackingRoute = createTrackingRoutes({ db });
const handleKycFleetRoute = createKycFleetRoutes({ db, redisLockManager, driverLocationService, websocketService, enforceSecurityChecks, parseJsonBody });
const handleAdminContentRoute = createAdminContentRoutes({ db, paymentProvider, notificationProvider, enforceSecurityChecks, parseJsonBody });
const handleDriverPartnerRoute = createDriverPartnerRoutes({ db, dispatchService, driverLocationService, redisLockManager, documentOcrProvider, deliveryStateMachine, DELIVERY_STATES, enforceSecurityChecks, enforceDriverAccess, parseJsonBody });
const handleAdminCancellationRoute = createAdminCancellationRoutes({ db, paymentProvider, enforceSecurityChecks, parseJsonBody });
const handlePaymentRoute = createPaymentRoutes({ db, paymentProvider, enforceSecurityChecks, parseJsonBody, validateFields });
const handleRadarRoute = createRadarRoutes({ db, enforceSecurityChecks });
const handleProofRoute = createProofRoutes({ db, enforceDriverAccess, enforceSecurityChecks });
const handleMerchantRoute = createMerchantRoutes({ db, createTextPdf, parseJsonBody, validateFields });
const handleMerchantBatchRoute = createMerchantBatchRoutes({ db, authService, fareQuoteProvider, dispatchService, slaService, parseJsonBody, validateFields });
const handleFleetVendorRoute = createFleetVendorRoutes({ db, parseJsonBody, validateFields });
const handleSafetyRoute = createSafetyRoutes({ db, enforceSecurityChecks, enforceDriverAccess, parseJsonBody, validateFields, isLatitude, isLongitude });
const handleSupportRoute = createSupportRoutes({ db, enforceSecurityChecks, parseJsonBody, validateFields });

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '127.0.0.1';
const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:4000,http://127.0.0.1:4000'))
  .split(',').map(origin => origin.trim()).filter(Boolean);
function isAdminFeatureEnabled(key) {
  const settings = db.getSystemSettings ? db.getSystemSettings() : {};
  const flags = settings.featureFlags || {};
  // Missing flags retain legacy behavior; only an explicit false disables a feature.
  return flags[key] !== false;
}

const securityHeaders = require('helmet');
const helmetHandler = securityHeaders({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", 'https://unpkg.com', 'https://cdnjs.cloudflare.com'],
      'script-src-attr': ["'none'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com', 'https://unpkg.com', 'https://cdnjs.cloudflare.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'", 'https:', 'wss:', 'ws:'],
      'frame-ancestors': ["'none'"]
    }
  },
  strictTransportSecurity: process.env.NODE_ENV === 'production',
  crossOriginEmbedderPolicy: false
});

// Durable responses: a response is sent only after every write made while handling the request is
// committed to PostgreSQL. If the commit fails, the client gets 503 instead of a false success.
function holdResponseUntilCommitted(res) {
  const rawEnd = res.end.bind(res);
  let held = false;
  res.end = function durableEnd(...args) {
    if (held || !db.hasPendingWrites()) return rawEnd(...args);
    held = true;
    db.waitForCommit().then(
      () => rawEnd(...args),
      (error) => {
        console.error('[VAAYU] Commit failed; response withheld:', error.message);
        if (!res.headersSent) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
        }
        rawEnd(JSON.stringify({ success: false, error: 'Data could not be saved. Please retry.' }));
      }
    );
    return res;
  };
}

// Reads the whole request body before routing. Handlers attach their own 'data'/'end' listeners,
// sometimes after an await; a stream that already ended would never fire 'end' again and the
// request would hang. This buffers the body, enforces the size cap, and replays it to listeners.
// Returns the replay function, or null after answering 413 when the body is too large.
async function readBodyOnce(req, res, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) {
    res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
    res.end(JSON.stringify({ success: false, error: 'Request body exceeds the 1 MB limit.' }));
    req.on('data', () => {});
    req.resume();
    return null;
  }
  const chunks = [];
  let size = 0;
  const result = await new Promise((resolve) => {
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
  if (result === null) {
    if (!res.headersSent) {
      res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({ success: false, error: 'Request body exceeds the 1 MB limit.' }));
    }
    req.destroy();
    return null;
  }
  const body = result;
  const originalOn = req.on.bind(req);
  req.on = (event, listener) => {
    if (event === 'data') {
      setImmediate(() => { if (body.length) listener(body); });
      return req;
    }
    if (event === 'end') {
      setImmediate(() => listener());
      return req;
    }
    return originalOn(event, listener);
  };
  return true;
}

const server = http.createServer(async (req, res) => {
  holdResponseUntilCommitted(res);
  await new Promise((resolve) => helmetHandler(req, res, resolve));
  const requestUrl = new URL(req.url, 'http://localhost');
  const parsedUrl = { pathname: requestUrl.pathname, query: Object.fromEntries(requestUrl.searchParams) };
  const rawPathname = parsedUrl.pathname;
  const pathname = routeRegistryService.resolvePath(rawPathname);

  // Global body cap: 1 MB for every route, except the routes that enforce their own larger limit.
  const ownLimitRoutes = new Set(['/api/trip/emergency-reject', '/api/webhooks/razorpayx', '/api/trip/proof-photo']);
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (!ownLimitRoutes.has(pathname) && declaredLength > 1024 * 1024) {
    res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
    res.end(JSON.stringify({ success: false, error: 'Request body exceeds the 1 MB limit.' }));
    req.resume();
    return;
  }
  if (!ownLimitRoutes.has(pathname) && req.method !== 'GET' && req.method !== 'HEAD') {
    const replay = await readBodyOnce(req, res, 1024 * 1024);
    if (!replay) return;
  }

  if (pathname === '/api/webhooks/razorpayx' && req.method === 'POST') {
    const webhookSecret = process.env.RAZORPAYX_WEBHOOK_SECRET || '';
    let rawBody = Buffer.alloc(0);
    let tooLarge = false;
    req.on('data', chunk => {
      if (rawBody.length + chunk.length > 1024 * 1024) { tooLarge = true; return; }
      rawBody = Buffer.concat([rawBody, chunk]);
    });
    req.on('end', () => {
      if (tooLarge) { res.writeHead(413); return res.end(); }
      if (webhookSecret.length < 32) { res.writeHead(503); return res.end(); }
      const supplied = String(req.headers['x-razorpay-signature'] || '');
      const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest();
      let actual;
      try { actual = Buffer.from(supplied, 'hex'); } catch (_) { actual = Buffer.alloc(0); }
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) { res.writeHead(401); return res.end(); }
      let event;
      try { event = JSON.parse(rawBody.toString('utf8')); } catch (_) { res.writeHead(400); return res.end(); }
      const payout = event?.payload?.payout?.entity;
      if (!payout?.id || !['payout.processed', 'payout.reversed', 'payout.failed', 'payout.rejected', 'payout.queued', 'payout.pending', 'payout.processing'].includes(String(event.event || ''))) {
        res.writeHead(200); return res.end(JSON.stringify({ received: true, ignored: true }));
      }
      const local = db.getPayoutByProviderId ? db.getPayoutByProviderId(payout.id) : null;
      if (!local) { res.writeHead(200); return res.end(JSON.stringify({ received: true, ignored: true })); }
      const updated = db.updatePayoutTransfer(local.id, {
        provider: 'razorpayx', payoutId: payout.id, status: payout.status,
        utr: payout.utr || null, amount: Number(payout.amount || 0) / 100
      });
      res.writeHead(updated ? 200 : 409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ received: Boolean(updated) }));
    });
    return;
  }

  // CORS Headers & Portal Disambiguation Headers
  const requestOrigin = req.headers && req.headers.origin;
  if (requestOrigin && configuredOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID, X-Idempotency-Key, X-Client-Portal, X-Client-Channel, X-Client-Version, X-Correlation-ID');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Client-Portal, X-Correlation-ID');

  // Extract or Generate Request Correlation ID & Multi-Portal Context
  const incomingReqId = req.headers ? (req.headers['x-request-id'] || req.headers['X-Request-ID']) : null;
  const requestId = (incomingReqId && typeof incomingReqId === 'string' && incomingReqId.trim().length > 0)
    ? incomingReqId.trim()
    : `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  req.requestId = requestId;
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('X-Request-ID', requestId);

  // Attach Portal Context
  const portalContext = portalContextService.extractPortalContext(req);
  res.setHeader('X-Client-Portal', portalContext.portalId);
  res.setHeader('X-Correlation-ID', portalContext.correlationId);

  if (req.method === 'OPTIONS') {
    if (requestOrigin && !configuredOrigins.includes(requestOrigin)) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }


  // Global Admin Endpoint Security Filter
  if (pathname.startsWith('/api/admin/') && req.method !== 'OPTIONS' && pathname !== '/api/admin/login') {
    // Strict default: an /api/admin/ path not listed below is reachable by ADMIN and SUPER_ADMIN only.
    // Widen a path by adding an explicit branch, never by changing this default.
    let requiredRoles = ['ADMIN', 'SUPER_ADMIN'];
    const dispatchReadPaths = ['/api/admin/fleet/live', '/api/admin/trips', '/api/admin/trips/active', '/api/admin/drivers', '/api/admin/analytics', '/api/admin/search', '/api/admin/alerts'];
    const adminOnlyPaths = pathname === '/api/admin/settings' || pathname.startsWith('/api/admin/settings/') || pathname.startsWith('/api/admin/advertisements') || pathname.startsWith('/api/admin/automations/') || pathname.startsWith('/api/admin/payouts') || pathname.startsWith('/api/admin/export/') || pathname.startsWith('/api/admin/broadcasts') || pathname === '/api/admin/otp/requests';
    if (adminOnlyPaths) {
      requiredRoles = ['ADMIN', 'SUPER_ADMIN'];
    } else if (pathname.startsWith('/api/admin/dispatch/') || dispatchReadPaths.includes(pathname) || pathname === '/api/admin/trips/update-status' || pathname === '/api/admin/trips/cancel-override' || pathname === '/api/admin/drivers/update-kyc' || pathname === '/api/admin/drivers/update-status') {
      requiredRoles = ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'];
    } else if (pathname.startsWith('/api/admin/rejections')) {
      requiredRoles = ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'];
    } else if (pathname.startsWith('/api/admin/support/') || pathname.startsWith('/api/admin/disputes') || pathname === '/api/admin/customers' || pathname === '/api/admin/customers/wallet-credit') {
      requiredRoles = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT_AGENT'];
    }
    const secPassed = await enforceSecurityChecks(req, res, { requiredRoles });
    if (!secPassed) return;
  }

  if (pathname.startsWith('/api/merchant/') && pathname !== '/api/merchant/register' && pathname !== '/api/merchant/calculate-savings') {
    const requestedMerchantId = parsedUrl.query.merchant_id || parsedUrl.query.merchantId || null;
    if (!await enforceMerchantAccess(req, res, requestedMerchantId)) return;
  }
  if (pathname === '/api/merchant/register' && req.method === 'POST') {
    if (!await enforceSecurityChecks(req, res, { routeName: 'merchant:register', requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'] })) return;
  }
  if (pathname.startsWith('/api/fleet/')) {
    const requestedOwnerId = parsedUrl.query.owner_id || parsedUrl.query.ownerId || null;
    if (!await enforceFleetOwnerAccess(req, res, requestedOwnerId)) return;
  }

  if (pathname === '/api/trips/reset-test' && req.method === 'POST') {
    if (process.env.NODE_ENV === 'production' || process.env.ENABLE_TEST_ENDPOINTS !== 'true') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not found' }));
      return;
    }
    if (!await enforceSecurityChecks(req, res, { routeName: 'trips:reset-test', requiredRoles: ['SUPER_ADMIN'] })) return;
  }

  // 1. Health & Readiness Endpoints
  if ((pathname.startsWith('/api/system/') || pathname === '/metrics' || pathname === '/api/metrics') && req.method !== 'OPTIONS') {
    if (!await enforceSecurityChecks(req, res, { routeName: 'ops:introspection', requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return;
  }

  if (await handleOpsRoute(req, res, { pathname, parsedUrl })) return;

  // 2. SEND OTP ENDPOINT
  if (await handleAuthRoute(req, res, { pathname, parsedUrl })) return;

  if (pathname.startsWith('/api/auth/otp-display/') && req.method === 'GET') {
    res.writeHead(410, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Use the OTP console. Login codes are not exposed through this endpoint.' }));
  }

  if (await handleGeocodingRoute(req, res, { pathname, parsedUrl })) return;

  if (await handleDriverTelemetryRoute(req, res, { pathname, parsedUrl })) return;

  if (await handleCatalogRoute(req, res, { pathname, parsedUrl })) return;


  if (await handleDriverRegistrationRoute(req, res, { pathname, parsedUrl })) return;

  // 7B. Reset Test Trips (Testing Utility)
  if (pathname === '/api/trips/reset-test' && req.method === 'POST') {
    const dbStore = db.getDb();
    dbStore.trips = [];
    if (dbStore.driver_profiles) {
      dbStore.driver_profiles = dbStore.driver_profiles.filter(d => !d.id.startsWith('drv_hotspot_') && !d.id.startsWith('drv_large_pool_'));
      const p1 = dbStore.driver_profiles.find(d => d.id === null);
      if (p1) { p1.totalTrips = 0; p1.todayTrips = 0; }
    }
    db.saveDb(dbStore);
    if (dispatchService.resetDispatchState) {
      await dispatchService.resetDispatchState();
    }
    if (driverLocationService.clearDriverLocation) {
      await driverLocationService.clearDriverLocation(null);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, message: 'Test trips and temporary drivers cleared' }));
  }

  if (await handleTripBookingRoute(req, res, { pathname })) return;

  if (await handleDispatchRoute(req, res, { pathname, parsedUrl })) return;

  if (await handleProofRoute(req, res, { pathname, parsedUrl })) return;
  if (await handleOrderRoute(req, res, { pathname, parsedUrl })) return;

  if (await handleCustomerRoute(req, res, { pathname, parsedUrl })) return;

  if (await handleAdminAuthRoute(req, res, { pathname, parsedUrl })) return;

  if (await handleAdminOpsRoute(req, res, { pathname, parsedUrl })) return;

  if (await handleAdminDispatchRoute(req, res, { pathname })) return;

  if (await handleBreakdownRoute(req, res, { pathname })) return;

  if (await handleTrackingRoute(req, res, { pathname })) return;

  if (await handleKycFleetRoute(req, res, { pathname, parsedUrl })) return;

  if (await handleAdminContentRoute(req, res, { pathname })) return;

  if (await handleDriverPartnerRoute(req, res, { pathname, parsedUrl })) return;

  if (await handleAdminCancellationRoute(req, res, { pathname, parsedUrl })) return;

  if (await handlePaymentRoute(req, res, { pathname, parsedUrl })) return;


  if (await handleRadarRoute(req, res, { pathname, parsedUrl })) return;

  if (await handleMerchantRoute(req, res, { pathname, parsedUrl })) return;

  if (await handleMerchantBatchRoute(req, res, { pathname, parsedUrl })) return;

  if (await handleFleetVendorRoute(req, res, { pathname })) return;

  if (await handleSafetyRoute(req, res, { pathname })) return;

  if (await handleSupportRoute(req, res, { pathname })) return;

  if (pathname === '/api/admin/analytics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      analytics: db.getAdminAnalytics ? db.getAdminAnalytics() : {}
    }));
  }

  if (pathname === '/api/admin/trips' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      trips: db.getTrips ? db.getTrips() : []
    }));
  }

  if (pathname === '/api/admin/trips/update-status' && req.method === 'POST') {
    if (!await enforceSecurityChecks(req, res, { routeName: 'admin:trip-status-update', requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR'] })) return;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let data = {};
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
      const allowedStatuses = ['DRIVER_ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'FAILED'];
      if (!data.tripId || !allowedStatuses.includes(String(data.status || '').toUpperCase())) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: `tripId and a status from ${allowedStatuses.join(', ')} are required.` }));
      }
      const updated = db.updateTripStatus ? await db.updateTripStatus(data.tripId, String(data.status).toUpperCase()) : null;
      res.writeHead(updated ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(updated ? { success: true, trip: updated } : { success: false, error: 'Trip not found.' }));
    });
    return;
  }

  // Driver self-registration review queue (admin).
  if (pathname === '/api/admin/driver-applications' && req.method === 'GET') {
    const status = parsedUrl.query.status ? String(parsedUrl.query.status).toUpperCase() : null;
    const applications = (db.getDb().driver_applications || [])
      .filter(a => !status || a.status === status)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ success: true, applications }));
  }

  // Approve or reject a driver application (admin). Approval creates the driver profile
  // with the same OFFLINE and KYC PENDING state as an admin-created driver.
  if (pathname.startsWith('/api/admin/driver-applications/') && pathname.endsWith('/decision') && req.method === 'POST') {
    const applicationId = pathname.slice('/api/admin/driver-applications/'.length, -'/decision'.length);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const data = parseJsonBody(res, body);
      if (!data) return;
      const decision = String(data.decision || '').toUpperCase();
      if (!['APPROVE', 'REJECT'].includes(decision)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Decision must be APPROVE or REJECT.' }));
      }
      const application = (db.getDb().driver_applications || []).find(a => a.id === applicationId);
      if (!application) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Application not found.' }));
      }
      if (application.status !== 'PENDING') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: `This application is already ${application.status.toLowerCase()}.` }));
      }
      if (decision === 'REJECT' && !String(data.note || '').trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'A reason is required to reject an application.' }));
      }

      let driver = null;
      if (decision === 'APPROVE') {
        const result = db.createDriverProfile({
          name: application.name,
          phone: application.phone,
          vehicleId: application.vehicleId,
          vehicleNumber: application.vehicleNumber,
          licenseNumber: application.licenseNumber,
          city: application.city,
          email: application.email,
        });
        if (!result.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(result));
        }
        driver = result.driver;
      }

      const target = db.decideDriverApplication(applicationId, {
        status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        reviewedBy: req.user.id,
        reviewNote: String(data.note || '').slice(0, 300) || null,
        driverId: driver ? driver.id : null,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        message: decision === 'APPROVE' ? 'Application approved. KYC is pending review before the driver can go online.' : 'Application rejected.',
        application: target,
        driver,
      }));
    });
    return;
  }

  if (pathname === '/api/admin/customers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      customers: db.getCustomers ? db.getCustomers() : []
    }));
  }

  if (pathname === '/api/admin/pricing/update' && req.method === 'POST') {
    if (!await enforceSecurityChecks(req, res, { routeName: 'admin:pricing-update', requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
      const fields = ['baseFare', 'includedKm', 'perKmRate', 'perMinRate', 'helperCharge'];
      if (!data.vehicleId || !fields.some(field => data[field] !== undefined) || fields.some(field => data[field] !== undefined && (!Number.isFinite(Number(data[field])) || Number(data[field]) < 0))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'A vehicle and non-negative numeric pricing values are required.' }));
      }
      const updated = db.updateVehiclePricing ? db.updateVehiclePricing(data.vehicleId, data) : null;
      res.writeHead(updated ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(updated ? { success: true, vehicle: updated } : { success: false, error: 'Vehicle not found.' }));
    });
    return;
  }

  if (pathname === '/api/admin/customers/wallet-credit' && req.method === 'POST') {
    if (!await enforceSecurityChecks(req, res, { routeName: 'admin:customer-wallet-credit', requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'SUPPORT_AGENT'] })) return;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body); } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload' }));
      }
      if (!data.customerId || !Number.isFinite(Number(data.amount)) || Number(data.amount) <= 0 || Number(data.amount) > 5000 || !String(data.reason || '').trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'customerId, a reason, and a credit from ₹0.01 to ₹5,000 are required.' }));
      }
      try {
        const result = db.creditCustomerWallet(data.customerId, data.amount, data.reason, req.user.id);
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Customer not found.' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, ...result }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  if (pathname === '/api/admin/settings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      settings: db.getSystemSettings ? db.getSystemSettings() : {}
    }));
  }

  if (pathname === '/api/admin/settings/update' && req.method === 'POST') {
    if (!await enforceSecurityChecks(req, res, { routeName: 'admin:settings-update', requiredRoles: ['ADMIN', 'SUPER_ADMIN'] })) return;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Settings payload cannot be empty.' }));
      }
      if (data.maintenanceMode !== undefined && req.user.role !== 'SUPER_ADMIN') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Only a Super Admin can change maintenance mode.' }));
      }
      if (data.surgeMultiplier !== undefined && (!Number.isFinite(Number(data.surgeMultiplier)) || Number(data.surgeMultiplier) < 1 || Number(data.surgeMultiplier) > 3)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Surge multiplier must be between 1.0 and 3.0.' }));
      }
      if (data.featureFlags && (typeof data.featureFlags !== 'object' || Array.isArray(data.featureFlags) || Object.values(data.featureFlags).some(value => typeof value !== 'boolean'))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Feature flags must be a map of boolean values.' }));
      }
      if (Object.keys(data).some(key => !['maintenanceMode', 'surgeMultiplier', 'featureFlags'].includes(key)) || (data.maintenanceMode !== undefined && typeof data.maintenanceMode !== 'boolean')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Unsupported or invalid settings field.' }));
      }
      const updated = db.updateSystemSettings ? db.updateSystemSettings(data) : null;
      res.writeHead(updated ? 200 : 500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(updated ? { success: true, settings: updated } : { success: false, error: 'Could not save settings.' }));
    });
    return;
  }

  if (pathname === '/api/admin/support/tickets' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      tickets: db.getSupportTickets ? db.getSupportTickets() : []
    }));
  }

  if (pathname === '/api/admin/support/update' && req.method === 'POST') {
    if (!await enforceSecurityChecks(req, res, { routeName: 'admin:support-update', requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'SUPPORT_AGENT'] })) return;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
      if (!data.ticketId || (data.reply !== undefined && !String(data.reply).trim()) || (data.status !== undefined && !['OPEN', 'IN_PROGRESS', 'RESOLVED'].includes(String(data.status).toUpperCase()))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'ticketId, a non-empty reply, and a valid status are required.' }));
      }
      const updated = db.updateSupportTicket ? db.updateSupportTicket(data.ticketId, data) : null;
      res.writeHead(updated ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(updated ? { success: true, ticket: updated } : { success: false, error: 'Support ticket not found.' }));
    });
    return;
  }

  if (pathname === '/api/admin/automations/logs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      logs: db.getAutomationLogs ? db.getAutomationLogs() : []
    }));
  }

  // 21. B2B CORPORATE MERCHANT & BATCH BOOKING APIs
  // Static Frontend File Serving
  if (pathname.startsWith('/driver/uploads/documents/')) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ success: false, error: 'Use the authenticated document preview endpoint.' }));
    return;
  }
  if (pathname === '/fleet' || pathname === '/fleet/' || pathname === '/fleet.html') {
    res.writeHead(302, { Location: '/driver/index.html?mode=fleet', 'Cache-Control': 'no-store' });
    return res.end();
  }
  let targetPath = pathname;
  if (targetPath === '/driver' || targetPath === '/driver/') {
    targetPath = '/driver/index.html';
  }
  if (targetPath === '/merchant' || targetPath === '/merchant/') {
    targetPath = '/merchant.html';
  }
  if (targetPath === '/otp' || targetPath === '/otp/' || targetPath === '/otp-console' || targetPath === '/otp-console/') {
    targetPath = '/otp-console.html';
  }

  // Only the portal pages and assets are public. Scripts, databases, tests, and uploads under
  // public/ must never be served, so anything not on this list gets a plain 404.
  const PUBLIC_ASSETS = new Set([
    '/', '/index.html', '/admin.html', '/merchant.html', '/fleet.html', '/public-track.html',
    '/otp-console.html', '/otp-console.js', '/map-engine.js', '/manifest.json',
    '/driver/index.html', '/driver/app.js', '/driver/style.css',
    '/driver/leaflet.js', '/driver/leaflet.css', '/driver/hero_driver.jpg', '/driver/manifest.json',
    '/built/index.js', '/built/merchant.js', '/built/fleet.js', '/built/admin.js', '/built/public-track.js', '/built/tailwind.css', '/built/portal.css',
  ]);
  const publicRoot = path.resolve(__dirname, '../public');
  if (!PUBLIC_ASSETS.has(targetPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  let filePath = path.resolve(publicRoot, targetPath === '/' ? 'index.html' : `.${targetPath}`);
  if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      fs.readFile(path.join(__dirname, '../public/index.html'), (err2, indexContent) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(indexContent);
        }
      });
    } else {
      let ext = path.extname(filePath).toLowerCase();
      let contentType = 'text/html';
      if (ext === '.js') contentType = 'text/javascript';
      if (ext === '.css') contentType = 'text/css';
      if (ext === '.json') contentType = 'application/json';
      if (ext === '.png') contentType = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      if (ext === '.svg') contentType = 'image/svg+xml';
      if (ext === '.webm') contentType = 'video/webm';
      if (ext === '.mp4') contentType = 'video/mp4';

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

// Slow clients cannot hold sockets open indefinitely. keepAliveTimeout stays below headersTimeout, as Node requires.
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 5_000;

let merchantScheduleRunInProgress = false;
async function processDueMerchantSchedules() {
  if (merchantScheduleRunInProgress || !db.getDueMerchantSchedules) return;
  merchantScheduleRunInProgress = true;
  try {
    const dueSchedules = db.getDueMerchantSchedules(new Date());
    for (const schedule of dueSchedules) {
      try {
        const quote = await fareQuoteProvider.getFareQuote(schedule.pickupLat, schedule.pickupLng, schedule.dropLat, schedule.dropLng, { vehicleId: schedule.vehicleType || 'v_ace' });
        if (!quote.success || !quote.selectedEstimate) throw new Error(quote.error || 'No fare quote is available for this scheduled vehicle.');
        const estimate = quote.selectedEstimate;
        const result = db.createBatchBookings(schedule.merchantId, [{
          merchantName: (db.getMerchants(schedule.merchantId) || [])[0]?.businessName,
          pickupAddress: schedule.pickupAddress,
          pickupLat: schedule.pickupLat,
          pickupLng: schedule.pickupLng,
          dropAddress: schedule.dropAddress,
          dropLat: schedule.dropLat,
          dropLng: schedule.dropLng,
          vehicleId: estimate.vehicleId,
          vehicleName: estimate.vehicleName,
          fare: estimate.totalFare,
          fareBreakdown: estimate.fareBreakdown,
          distanceKm: quote.distanceKm,
          durationMin: quote.durationMin,
          goodsCategory: schedule.itemDescription || 'Scheduled Commercial Goods',
          businessOrderId: `SCHED-${schedule.id}-${schedule.dueDate}`,
          poReference: schedule.id
        }], { scheduleId: schedule.id, runDate: schedule.dueDate });
        if (!result.success) throw new Error(result.error || 'The scheduled shipment could not be created.');
        const trip = result.trips[0];
        const dispatch = await dispatchService.findAndOfferDriver(trip.id);
        logger.info('merchant_schedule_executed', `Scheduled shipment ${trip.id} created from schedule ${schedule.id}`, { scheduleId: schedule.id, orderId: trip.id, dispatchStarted: Boolean(dispatch?.success) });
      } catch (error) {
        logger.error('merchant_schedule_failed', `Scheduled run ${schedule.id} failed: ${error.message}`, { scheduleId: schedule.id, dueDate: schedule.dueDate });
      }
    }
  } catch (error) {
    logger.error('merchant_schedule_poll_failed', error.message || 'Could not poll merchant schedules.');
  } finally {
    merchantScheduleRunInProgress = false;
  }
}

const ENABLE_CLUSTER = process.env.ENABLE_CLUSTER === 'true';
if (ENABLE_CLUSTER) {
  // Each worker keeps its own in-memory state, so workers would diverge. Refuse until state is shared.
  throw new Error('ENABLE_CLUSTER=true is not supported: state is per process and would diverge across workers.');
}

// Keep serving when a single request or background task fails; log it for triage.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', 'Unhandled promise rejection', { message: reason && reason.message ? reason.message : String(reason) });
});
process.on('uncaughtException', (error) => {
  logger.error('uncaught_exception', 'Uncaught exception', { message: error.message, stack: error.stack });
});

// The external Redis client is lazy: commands issued before connect() queue forever. Connect it up
// front so rate limiting and locks respond, and refuse to start in production if Redis is down.
const redisReady = redisRateLimiter.redis.connect().then((ok) => {
  if (!ok && process.env.NODE_ENV === 'production') throw new Error('Redis is unreachable; refusing to start without rate limiting.');
  return ok;
});

// -------------------------------------------------------------
// Real-Time WebSocket Server Gateway
// -------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const pathname = requestUrl.pathname;

  // Only upgrade on /ws or /socket.io paths
  if (pathname !== '/ws' && pathname !== '/socket.io' && !pathname.startsWith('/socket.io/')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Extract auth token from query params or Authorization header
  const token = requestUrl.searchParams.get('token') || authService.extractToken(req);
  if (!token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const user = authService.verifyToken(token);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, user, token);
  });
});

wss.on('connection', (ws, req, user, token) => {
  const clientId = websocketService.registerClient(ws, user.role, user.id, user.role, token);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.action === 'join' && data.room) {
        const joinRes = websocketService.joinRoom(clientId, data.room);
        ws.send(JSON.stringify({ event: 'room_joined', room: data.room, success: joinRes.success, error: joinRes.error }));
      } else if (data.action === 'leave' && data.room) {
        websocketService.leaveRoom(clientId, data.room);
        ws.send(JSON.stringify({ event: 'room_left', room: data.room, success: true }));
      } else if (data.action === 'ping') {
        const client = websocketService.clients.get(clientId);
        if (client) client.lastPingMs = Date.now();
        ws.send(JSON.stringify({ event: 'pong', timestamp: new Date().toISOString() }));
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    websocketService.unregisterClient(clientId);
  });

  ws.on('error', () => {
    websocketService.unregisterClient(clientId);
  });

  ws.send(JSON.stringify({
    event: 'connected',
    clientId,
    user: { id: user.id, role: user.role, name: user.name },
    timestamp: new Date().toISOString()
  }));
});

Promise.all([db.initPersistence(), redisReady]).then(() => server.listen(PORT, HOST, () => {
    console.log(`VAAYU server ${process.pid} running on http://localhost:${PORT} (Hyderabad and custom locations)`);
    const scheduleTimer = setInterval(processDueMerchantSchedules, 30_000);
    scheduleTimer.unref();
    const initialSchedulePoll = setTimeout(processDueMerchantSchedules, 5_000);
    initialSchedulePoll.unref();
  })).catch((error) => {
    // pg reports connection failures as AggregateError, whose own message is empty.
    const causes = Array.isArray(error.errors) ? error.errors.map((e) => e.message).join('; ') : '';
    console.error('[VAAYU] Persistence failed to start; refusing to serve:', error.message || causes || error.code || 'unknown error');
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`[VAAYU] ${signal} received; flushing data before exit.`);
    server.close(() => {
      db.shutdownPersistence().then(() => process.exit(0), (error) => {
        console.error('[VAAYU] Shutdown flush failed:', error.message);
        process.exit(1);
      });
    });
  };
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
