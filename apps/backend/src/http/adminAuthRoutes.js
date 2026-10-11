// Admin sign-in and the OTP console. Branch logic is moved from server_production.js. Each matched route answers and
// returns true at once, so the router stops here, including when a guard has refused the request. The OTP console
// route is gated by the global /api/admin/ filter in server_production.js, which runs before this module.

function createAdminAuthRoutes({
  redisRateLimiter, parseJsonBody, configuredAdminUsers, ADMIN_PERMISSIONS, authService, otpChallenges, crypto
}) {
  return async function handleAdminAuthRoute(req, res, { pathname, parsedUrl }) {
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const rateCheck = await redisRateLimiter.checkRateLimit(req, res, 'auth:admin-login');
      if (rateCheck.error && process.env.NODE_ENV === 'production') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Admin login is unavailable because security rate limiting is down.' }));
        return true;
      }
      if (!rateCheck.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Too many login attempts. Try again later.' }));
        return true;
      }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const username = String(data.username || '').trim().toLowerCase();
        const password = String(data.password || '');
        const accounts = configuredAdminUsers();
        if (!accounts.length) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Admin login is not configured on this server.' }));
        }
        const account = accounts.find(candidate => candidate.username.toLowerCase() === username);
        const suppliedBytes = Buffer.from(password);
        const expectedBytes = Buffer.from(account ? account.password : crypto.randomBytes(Math.max(1, suppliedBytes.length)).toString());
        const passwordMatches = suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
        if (!account || !passwordMatches || (data.role && data.role !== account.role)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Invalid username, password, or role.' }));
        }

        const adminUser = {
          id: account.id || `adm_${crypto.createHash('sha256').update(username).digest('hex').slice(0, 12)}`,
          username: account.username,
          name: account.name || account.username,
          role: account.role,
          title: account.title || account.role.replaceAll('_', ' '),
          permissions: ADMIN_PERMISSIONS[account.role]
        };

        const token = authService.generateToken(adminUser);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: `Welcome, ${adminUser.name}! Logged in as ${adminUser.role}.`,
          adminUser,
          token
        }));
      });
      return true;
    }

    // OTP console: login codes for every portal, visible only to top admins (gated upstream).
    if (pathname === '/api/admin/otp/requests' && req.method === 'GET') {
      const limit = Number(parsedUrl.query.limit) || 100;
      const app = parsedUrl.query.app ? String(parsedUrl.query.app).toUpperCase() : null;
      const status = parsedUrl.query.status ? String(parsedUrl.query.status).toUpperCase() : null;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        success: true,
        mode: otpChallenges.mode(),
        summary: otpChallenges.summary(),
        requests: otpChallenges.listForOperator({ limit, app, status }),
      }));
      return true;
    }

    return false;
  };
}

module.exports = { createAdminAuthRoutes };
