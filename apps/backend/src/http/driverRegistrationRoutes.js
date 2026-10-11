// Driver self-registration routes: verify the applicant's phone, file a pending application, and report
// application status. A driver profile exists only after an admin approves the application.
// Branch logic is moved unchanged from server_production.js. Each matched route answers and returns true
// at once, so the router stops here.

function createDriverRegistrationRoutes({ db, otpChallenges, OtpError, redisRateLimiter, parseJsonBody }) {
  return async function handleDriverRegistrationRoute(req, res, { pathname, parsedUrl }) {
    // Registration proof: verifies the phone's code and returns a verificationId only. It never
    // issues a login token, because the applicant is not an approved driver yet.
    if (pathname === '/api/driver/register/verify-phone' && req.method === 'POST') {
      const rateCheck = await redisRateLimiter.checkRateLimit(req, res, 'driver:register-verify');
      if (rateCheck.error && process.env.NODE_ENV === 'production') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Security rate limiting is unavailable.' }));
        return true;
      }
      if (!rateCheck.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: rateCheck.message || 'Too many attempts. Try again later.' }));
        return true;
      }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        const cleanPhone = String(data.phone || '').replace(/\D/g, '').slice(-10);
        if (cleanPhone.length !== 10 || !/^\d{6}$/.test(String(data.otp || ''))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Enter the 6-digit code sent to your mobile.' }));
        }
        try {
          const verified = otpChallenges.verify({ phone: cleanPhone, code: data.otp });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify({ success: true, verificationId: verified.challengeId }));
        } catch (error) {
          if (!(error instanceof OtpError)) throw error;
          res.writeHead(error.status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: error.message, code: error.code, ...(error.extra || {}) }));
        }
      });
      return true;
    }

    // Driver self-registration. Creates a pending application only.
    if (pathname === '/api/driver/register' && req.method === 'POST') {
      const rateCheck = await redisRateLimiter.checkRateLimit(req, res, 'driver:register');
      if (rateCheck.error && process.env.NODE_ENV === 'production') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Security rate limiting is unavailable.' }));
        return true;
      }
      if (!rateCheck.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: rateCheck.message || 'Too many attempts. Try again later.' }));
        return true;
      }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        const fail = (status, error) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error }));
        };

        const name = String(data.name || '').trim();
        const phone = String(data.phone || '').replace(/\D/g, '').slice(-10);
        const vehicleId = String(data.vehicleId || '').trim();
        const licenseNumber = String(data.licenseNumber || '').trim().toUpperCase();
        const vehicleNumber = String(data.vehicleNumber || '').trim().toUpperCase();
        const city = String(data.city || 'Hyderabad').trim();

        if (name.length < 2) return fail(400, 'Please enter your full name.');
        if (phone.length !== 10) return fail(400, 'Please enter a valid 10-digit mobile number.');
        if (!(db.getVehicles() || []).some(v => v.id === vehicleId)) return fail(400, 'Please choose the vehicle you will drive.');
        if (!/^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/.test(vehicleNumber.replace(/\s/g, ''))) return fail(400, 'Enter a valid vehicle registration number, for example TS09EA4589.');
        if (licenseNumber.length < 8) return fail(400, 'Enter a valid driving licence number.');
        const existingDriverUser = db.getUserByPhone(phone, 'DRIVER');
        if (existingDriverUser) return fail(409, 'A driver account already exists for this number. Sign in instead.');
        if ((db.getDrivers() || []).some(d => String(d.phone || '').replace(/\D/g, '').slice(-10) === phone)) return fail(409, 'A driver account already exists for this number. Sign in instead.');

        const pending = (db.getDb().driver_applications || []).find(a => a.phone === phone && a.status === 'PENDING');
        if (pending) return fail(409, 'An application for this number is already waiting for approval.');

        if (!otpChallenges.consumeVerification(String(data.verificationId || ''), phone)) {
          return fail(401, 'Verify your mobile number with the code sent to you before registering.');
        }

        const application = db.createDriverApplication({
          name,
          phone,
          vehicleId,
          vehicleNumber,
          licenseNumber,
          city,
          email: data.email,
          ownershipType: data.ownershipType || 'SELF',
          rcOwnerName: data.rcOwnerName || name,
          ownerConsent: data.ownerConsent !== undefined ? Boolean(data.ownerConsent) : true,
          capturedDocuments: data.capturedDocuments || {},
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: 'Application received. You can sign in once an admin approves it.',
          application: { id: application.id, status: application.status, createdAt: application.createdAt },
        }));
      });
      return true;
    }

    // Driver application status, checked by phone after OTP sign-in attempts.
    if (pathname === '/api/driver/application-status' && req.method === 'GET') {
      const phone = String(parsedUrl.query.phone || '').replace(/\D/g, '').slice(-10);
      if (phone.length !== 10) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Enter a valid 10-digit mobile number.' }));
        return true;
      }
      const application = (db.getDb().driver_applications || [])
        .filter(a => a.phone === phone)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        success: true,
        status: application ? application.status : 'NONE',
        reason: application ? application.reviewNote || null : null,
      }));
      return true;
    }

    return false;
  };
}

module.exports = { createDriverRegistrationRoutes };
