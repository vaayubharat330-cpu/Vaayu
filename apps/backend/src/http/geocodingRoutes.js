// Address search and reverse geocoding for the customer and driver apps. Both routes are public, as the
// apps use them before sign-in. Branch logic is moved unchanged from server_production.js. Each matched
// route answers and returns true at once, so the router stops here.

function createGeocodingRoutes({ mapEngine, redisRateLimiter }) {
  return async function handleGeocodingRoute(req, res, { pathname, parsedUrl }) {
    if ((pathname === '/api/geocoding/search' || pathname === '/api/geocoding/reverse') && req.method === 'GET') {
      const rateCheck = await redisRateLimiter.checkRateLimit(req, res, 'public:map');
      if (rateCheck.error && process.env.NODE_ENV === 'production') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Security rate limiting is unavailable.' }));
        return true;
      }
      if (!rateCheck.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: rateCheck.message || 'Too many requests. Try again later.' }));
        return true;
      }
    }

    if (pathname === '/api/geocoding/search' && req.method === 'GET') {
      const qRaw = (parsedUrl.query.q || '').trim();
      const refLat = parsedUrl.query.refLat == null ? 17.4850 : Number(parsedUrl.query.refLat);
      const refLng = parsedUrl.query.refLng == null ? 78.4041 : Number(parsedUrl.query.refLng);

      const searchResponse = await mapEngine.geocoding.search(qRaw, refLat, refLng);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(searchResponse));
      return true;
    }

    if (pathname === '/api/geocoding/reverse' && req.method === 'GET') {
      const lat = parsedUrl.query.lat;
      const lng = parsedUrl.query.lng;
      if (lat == null || lng == null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'lat and lng required' }));
        return true;
      }

      const reverseResponse = await mapEngine.geocoding.reverseGeocode(lat, lng);

      if (!reverseResponse.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reverseResponse));
        return true;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reverseResponse));
      return true;
    }

    return false;
  };
}

module.exports = { createGeocodingRoutes };
