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

const originalInitPersistence = db.initPersistence;
db.initPersistence = async function initPersistenceWithDispatchRecovery(...args) {
  await originalInitPersistence(...args);
  await dispatchRecoveryService.recoverPersistedOffers();
};

require('./server_production');
