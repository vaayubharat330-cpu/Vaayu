// Login OTP routes: send a code, verify it, and create or find the account.
// Branch logic is moved unchanged from server_production.js. Dependencies come from createAuthRoutes().
// The rate-limit gate is applied inside each handler through enforceAuthRateLimit, as before.

function createAuthRoutes({ db, otpChallenges, OtpError, authService, logger, parseJsonBody, enforceAuthRateLimit }) {
  return async function handleAuthRoute(req, res, { pathname, parsedUrl }) {
    let handled = false;
    const end = (...args) => {
      handled = true;
      res.end(...args);
      return true;
    };
    if (pathname === '/api/auth/send-otp' && req.method === 'POST') {
      if (!await enforceAuthRateLimit(req, res, 'auth:otp:send')) return true;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
  
        const { phone, isSignUp, name } = data;
  
        if (!phone || phone.replace(/\D/g, '').length < 10) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return end(JSON.stringify({ success: false, error: 'Please enter a valid 10-digit mobile number.' }));
        }
  
        if (isSignUp && (!name || name.trim().length < 2)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return end(JSON.stringify({ success: false, error: 'Please enter your full name.' }));
        }
  
        const cleanPhone = phone.replace(/\D/g, '').slice(-10);
  
        if (isSignUp) {
          const existingUser = db.getUserByPhone(cleanPhone, 'CUSTOMER');
          if (existingUser) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return end(JSON.stringify({
              success: false,
              error: 'Mobile number is already registered. Please click Login instead.'
            }));
          }
        }
  
        const appType = ['CUSTOMER', 'MERCHANT', 'DRIVER', 'FLEET_OWNER'].includes(String(data.appType || '').toUpperCase())
          ? String(data.appType).toUpperCase()
          : 'CUSTOMER';
        otpChallenges.send({ phone: cleanPhone, appType, purpose: 'LOGIN', ip: req.socket.remoteAddress }).then((challenge) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return end(JSON.stringify({
            success: true,
            message: `OTP sent to ${challenge.maskedPhone}`,
            challengeId: challenge.challengeId,
            maskedPhone: challenge.maskedPhone,
            expiresAt: challenge.expiresAt,
            resendAfterSeconds: challenge.resendAfterSeconds,
          }));
        }).catch(error => {
          if (error instanceof OtpError) {
            const headers = { 'Content-Type': 'application/json' };
            if (error.extra && error.extra.retryAfterSeconds) headers['Retry-After'] = String(error.extra.retryAfterSeconds);
            res.writeHead(error.status, headers);
            return end(JSON.stringify({ success: false, error: error.message, code: error.code }));
          }
          logger.error('otp_delivery_failed', 'OTP delivery failed', { message: error.message });
          res.writeHead(503, { 'Content-Type': 'application/json' });
          end(JSON.stringify({ success: false, error: 'OTP delivery is temporarily unavailable.' }));
        });
      });
      return true;
    }
  
    // 3. VERIFY OTP & LOGIN / SIGNUP ENDPOINT
    if (pathname === '/api/auth/verify-otp' && req.method === 'POST') {
      if (!await enforceAuthRateLimit(req, res, 'auth:otp:verify')) return true;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
  
        const { phone, otp, isSignUp, name, email, city } = data;
  
        if (!phone || phone.replace(/\D/g, '').length < 10 || !/^\d{6}$/.test(String(otp || ''))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return end(JSON.stringify({ success: false, error: 'Please enter the 6-digit verification code.' }));
        }
  
        const cleanPhone = phone.replace(/\D/g, '').slice(-10);
        let verifiedChallenge;
        try {
          verifiedChallenge = otpChallenges.verify({ phone: cleanPhone, code: otp });
        } catch (error) {
          if (!(error instanceof OtpError)) throw error;
          res.writeHead(error.status, { 'Content-Type': 'application/json' });
          return end(JSON.stringify({ success: false, error: error.message, code: error.code, ...(error.extra || {}) }));
        }
  
        const challengeApp = String(verifiedChallenge.appType || data.appType || 'CUSTOMER').toUpperCase();
        const matchingMerchants = (db.getMerchants ? db.getMerchants(null, cleanPhone) : [])
          .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
        const matchingFleetOwner = (db.getFleetOwners ? db.getFleetOwners() : []).find(owner =>
          String(owner.phone || '').replace(/\D/g, '').slice(-10) === cleanPhone
        );
        let user = null;
        if (challengeApp === 'MERCHANT' && matchingMerchants[0]) {
          user = { id: matchingMerchants[0].id, phone: matchingMerchants[0].phone, name: matchingMerchants[0].contactName || matchingMerchants[0].businessName, role: 'MERCHANT' };
        } else if (challengeApp === 'FLEET_OWNER' && matchingFleetOwner) {
          user = { id: matchingFleetOwner.userId || matchingFleetOwner.id, phone: matchingFleetOwner.phone, name: matchingFleetOwner.ownerName || matchingFleetOwner.companyName, role: 'FLEET_OWNER' };
        } else if (challengeApp === 'DRIVER') {
          user = db.getUserByPhone(cleanPhone, 'DRIVER');
        } else if (challengeApp === 'CUSTOMER') {
          user = db.getUserByPhone(cleanPhone, 'CUSTOMER');
        } else {
          user = matchingMerchants[0]
            ? { id: matchingMerchants[0].id, phone: matchingMerchants[0].phone, name: matchingMerchants[0].contactName || matchingMerchants[0].businessName, role: 'MERCHANT' }
            : (matchingFleetOwner
              ? { id: matchingFleetOwner.userId || matchingFleetOwner.id, phone: matchingFleetOwner.phone, name: matchingFleetOwner.ownerName || matchingFleetOwner.companyName, role: 'FLEET_OWNER' }
              : (db.getUserByPhone(cleanPhone, 'CUSTOMER') || db.getUserByPhone(cleanPhone, 'DRIVER')));
        }
  
        if (!user && !isSignUp) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return end(JSON.stringify({ success: false, error: 'Account not found. Please register first.' }));
        }
  
        if (!user) {
          user = {
            id: `usr_cust_${Date.now()}`,
            phone: `+91 ${cleanPhone}`,
            name: name ? name.trim() : 'Customer',
            email: email || `${cleanPhone}@vaayu.in`,
            city: city || 'Hyderabad',
            role: 'CUSTOMER',
            createdAt: new Date().toISOString()
          };
          db.createUser(user);
        }
  
        if (['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN', 'DISPATCH_OPERATOR', 'SUPPORT_AGENT'].includes(user.role)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return end(JSON.stringify({ success: false, error: 'Administrator accounts must authenticate through the configured admin login.' }));
        }
  
        otpChallenges.recordSignIn(verifiedChallenge.challengeId, user.role);
        const token = authService.generateToken(user);
        const driverProfile = user.role === 'DRIVER'
          ? (db.getDrivers() || []).find(profile => profile.userId === user.id || profile.id === user.id)
          : null;
  
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return end(JSON.stringify({
          success: true,
          message: 'OTP verified successfully!',
          user,
          ...(driverProfile ? { driverProfileId: driverProfile.id } : {}),
          token
        }));
      });
      return true;
    }

    return handled;
  };
}

module.exports = { createAuthRoutes };
