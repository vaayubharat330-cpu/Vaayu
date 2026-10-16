'use strict';

// Keep startup reconciliation behind the same persistence barrier as the HTTP server.
// server_production.js calls db.initPersistence() before listen(); wrapping that method
// lets restart recovery run only after the authoritative snapshot has been loaded.
const db = require('./db/database');
const { dispatchRecoveryService } = require('./services/dispatchRecoveryService');
const { authService } = require('./services/authService');
const { authorizeAdminRead } = require('./http/adminReadGuard');
const http = require('http');

const originalInitPersistence = db.initPersistence;
db.initPersistence = async function initPersistenceWithDispatchRecovery(...args) {
  await originalInitPersistence(...args);
  await dispatchRecoveryService.recoverPersistedOffers();
};

// server_production historically exposed a few admin GET endpoints before their
// route-local security checks. Intercept those reads at the HTTP boundary so an
// unauthenticated request can never reach the data-producing handler.
const originalCreateServer = http.createServer;
http.createServer = function createServerWithAdminReadBoundary(requestListener, ...args) {
  if (typeof requestListener !== 'function') return originalCreateServer.call(http, requestListener, ...args);

  const guardedListener = (req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
    const token = authService.extractToken(req);
    const decision = authorizeAdminRead({ pathname, method: req.method, token, authService });
    if (decision.required && !decision.allowed) {
      const status = decision.code === 'FORBIDDEN_ROLE' ? 403 : 401;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'WWW-Authenticate': status === 401 ? 'Bearer' : undefined
      });
      return res.end(JSON.stringify({ success: false, error: { code: decision.code, message: status === 403 ? 'Insufficient privileges.' : 'Authentication required.' } }));
    }
    return requestListener(req, res);
  };

  return originalCreateServer.call(http, guardedListener, ...args);
};

require('./server_production');
