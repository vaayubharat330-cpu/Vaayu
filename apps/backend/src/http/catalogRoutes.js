// Public catalog routes. GET /api/vehicles is open without sign-in because the driver app loads it
// before the driver signs in. Branch logic is moved unchanged from server_production.js.

function createCatalogRoutes({ db }) {
  return async function handleCatalogRoute(req, res, { pathname }) {
    if (pathname === '/api/vehicles' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        vehicles: db.getVehicles()
      }));
      return true;
    }
    return false;
  };
}

module.exports = { createCatalogRoutes };
