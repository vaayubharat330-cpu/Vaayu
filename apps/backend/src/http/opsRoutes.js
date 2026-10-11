// Operational endpoints: liveness, readiness, /api/system/* introspection, and metrics.
// The branch logic is moved unchanged from server_production.js. Dependencies come from createOpsRoutes().
// The caller applies the security gate for /api/system/ and /metrics before calling handleOpsRoute.

function createOpsRoutes({ db, redisRateLimiter, websocketService, routeRegistryService, PortalContextService, circuitBreakerService, metricsService }) {
  return async function handleOpsRoute(req, res, { pathname, parsedUrl }) {
    let handled = false;
    const end = (...args) => {
      handled = true;
      res.end(...args);
      return true;
    };
  if ((pathname === '/api/health' || pathname === '/health' || pathname === '/health/live') && req.method === 'GET') {
    const drivers = db.getDrivers ? db.getDrivers() : [];
    const vehicles = db.getVehicles ? db.getVehicles() : [];
    const trips = db.getTrips ? db.getTrips() : [];
    const payouts = db.getPayouts ? db.getPayouts() : [];
    const dailyLogs = db.getDailyLogs ? db.getDailyLogs() : [];
    const store = db.getDb ? db.getDb() : {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return end(JSON.stringify({
      success: true,
      status: 'UP',
      liveness: 'healthy',
      app: 'VAAYU Customer Auth & Logistics Engine',
      city: 'Hyderabad, Telangana',
      database: {
        status: 'CONNECTED',
        database: process.env.PERSISTENCE_PROVIDER === 'postgres' ? 'PostgreSQL' : process.env.PERSISTENCE_PROVIDER === 'sqlite' ? 'SQLite' : 'JSON file store',
        record_counts: { drivers: drivers.length, vehicles: vehicles.length, trips: trips.length, payouts: payouts.length, daily_logs: dailyLogs.length, telemetry_pings: (store.telemetry_logs || []).length }
      },
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }));
  }

  if (pathname === '/health/ready' && req.method === 'GET') {
    const provider = String(process.env.PERSISTENCE_PROVIDER || 'json').toLowerCase();
    const persistenceStatus = provider === 'postgres'
      ? 'postgres'
      : (provider === 'sqlite' ? 'sqlite' : 'json-file');
    let redisStatus = redisRateLimiter.redis && redisRateLimiter.redis.redis ? 'checking' : 'in-memory-development-only';
    let pubsubStatus = websocketService && websocketService.pubSub ? 'configured' : 'degraded';

    if (redisRateLimiter.redis && redisRateLimiter.redis.redis) {
      try { redisStatus = await redisRateLimiter.redis.connect() ? 'healthy' : 'unavailable'; }
      catch (_) { redisStatus = 'unavailable'; }
    }

    try {
      if (!websocketService || !websocketService.pubSub) pubsubStatus = 'degraded';
    } catch (_) { pubsubStatus = 'unavailable'; }

    const isReady = process.env.NODE_ENV !== 'production';
    const statusCode = isReady ? 200 : 503;

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    return end(JSON.stringify({
      status: isReady ? 'UP' : 'DOWN',
      readiness: isReady ? 'ready' : 'not_ready',
      services: {
        persistence: persistenceStatus,
        redis: redisStatus,
        pubsub: pubsubStatus
      },
      timestamp: new Date().toISOString()
    }));
  }

  // System Introspection & Route Registry Endpoints
  if (pathname === '/api/system/routes' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return end(JSON.stringify({
      success: true,
      routes: routeRegistryService.getRegisteredRoutes(),
      totalRoutes: routeRegistryService.routes.size,
      timestamp: new Date().toISOString()
    }));
  }

  if (pathname === '/api/system/portals' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return end(JSON.stringify({
      success: true,
      portals: PortalContextService.PORTALS,
      timestamp: new Date().toISOString()
    }));
  }

  if (pathname === '/api/system/context' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return end(JSON.stringify({
      success: true,
      portalContext: req.portalContext,
      timestamp: new Date().toISOString()
    }));
  }

  if (pathname === '/api/system/breakers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return end(JSON.stringify({
      success: true,
      circuitBreakers: circuitBreakerService.getStatus(),
      timestamp: new Date().toISOString()
    }));
  }

  // 1B. Metrics Endpoint
  if ((pathname === '/metrics' || pathname === '/api/metrics') && req.method === 'GET') {
    const format = parsedUrl.query.format || (req.headers.accept && req.headers.accept.includes('text/plain') ? 'prometheus' : 'json');

    if (format === 'prometheus') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      return end(metricsService.getPrometheusFormat());
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return end(JSON.stringify(metricsService.getSnapshot(), null, 2));
    }
  }


    return handled;
  };
}

module.exports = { createOpsRoutes };
