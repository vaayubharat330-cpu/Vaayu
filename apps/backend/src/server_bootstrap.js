'use strict';

// Keep startup reconciliation behind the same persistence barrier as the HTTP server.
// server_production.js calls db.initPersistence() before listen(); wrapping that method
// lets restart recovery run only after the authoritative snapshot has been loaded.
const db = require('./db/database');
const { dispatchRecoveryService } = require('./services/dispatchRecoveryService');
const { installHelmetCspCompat } = require('./security/helmetCspCompat');

// React portals use element-level style attributes for dynamic visual state.
// Install the CSP Level 3 style-src-attr compatibility before Helmet is loaded
// so style-src remains strict and is never weakened with unsafe-inline.
installHelmetCspCompat();

// The driver portal performs an anonymous bootstrap probe for its optional profile.
// An empty probe is a valid "no profile yet" state, not a missing API resource.
// Return 204 only for that unauthenticated, id-less probe; authenticated profile
// requests continue through the normal driver authorization and profile handlers.
const http = require('http');
const originalCreateServer = http.createServer;
http.createServer = function createServerWithDriverBootstrapGuard(requestListener, ...args) {
  return originalCreateServer.call(this, async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const isAnonymousDriverBootstrapProbe =
      req.method === 'GET' &&
      requestUrl.pathname === '/api/driver' &&
      !requestUrl.searchParams.get('id') &&
      !req.headers.authorization &&
      !req.headers.cookie;

    if (isAnonymousDriverBootstrapProbe) {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }

    return requestListener(req, res);
  }, ...args);
};

const originalInitPersistence = db.initPersistence;
db.initPersistence = async function initPersistenceWithDispatchRecovery(...args) {
  await originalInitPersistence(...args);
  await dispatchRecoveryService.recoverPersistedOffers();
};

require('./server_production');
