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
      // React portals use element-level style attributes for dynamic map and visual state.
      // CSP Level 3 separates style attributes from stylesheet elements, so keep style-src
      // strict while explicitly permitting the attributes the portal UI requires.
      'style-src-attr': ["'unsafe-inline'"],
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
    req.on('data', () => {});
    req.resume();
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
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        res.writeHead(401);
        return res.end(JSON.stringify({ success: false, error: 'Invalid signature.' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  if (pathname === '/health' && req.method === 'GET') {
    const health = db.getHealth ? await db.getHealth() : { status: 'UNKNOWN' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, status: 'UP', liveness: 'healthy', app: 'VAAYU Customer Auth & Logistics Engine', city: 'Hyderabad, Telangana', database: health, pid: process.pid, uptimeSec: Math.floor(process.uptime()), timestamp: new Date().toISOString() }));
  }

  // Static assets are served after the security headers are attached. This keeps the
  // browser-facing CSP consistent across HTML, JavaScript, CSS, and map assets.
  if (req.method === 'GET' || req.method === 'HEAD') {
    const staticResult = serveStaticAsset(req, res, pathname);
    if (staticResult) return;
  }

  // Global CORS policy.
  const requestOrigin = req.headers.origin;
  if (requestOrigin && configuredOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID, X-Idempotency-Key');
    res.writeHead(204);
    return res.end();
  }

  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID());
  res.setHeader('X-Request-ID', requestId);
  try {
    // The remainder of the production router is intentionally unchanged.
    const handled = await routeRequest({ req, res, pathname, requestId });
    if (handled) return;
    if (!res.writableEnded) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Route not found.' }));
    }
  } catch (error) {
    logger.error('Unhandled request error', { requestId, pathname, error: error.message });
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ success: false, error: 'Internal server error.', requestId }));
  }
});
