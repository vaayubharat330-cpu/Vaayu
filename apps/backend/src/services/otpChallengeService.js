// Login OTP challenges for the customer, merchant, driver and fleet portals.
// - A code is generated with a CSPRNG. Only a keyed HMAC of it is stored for verification.
// - Each challenge is scoped to one app and one purpose, expires, allows a fixed number of
//   attempts, and is single use.
// - Resends are limited per phone and per hour.
// Delivery channel (OTP_DELIVERY_WEBHOOK_URL / VAAYU_OTP_CONSOLE):
// - WEBHOOK: the code is sent to the SMS provider over a signed HTTPS request. Never shown anywhere.
// - CONSOLE: no SMS provider is connected. The code is kept encrypted (AES-256-GCM) until it is
//   used or expires, and only admins can read it on /otp-console.html. Production requires
//   VAAYU_OTP_CONSOLE=true to enable this, because it lets an admin sign in as the user.
// - NONE: production with no channel. Sending fails closed with 503.
const crypto = require('crypto');
const https = require('https');
const db = require('../db/database');

const CODE_LENGTH = 6;
const TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const APPS = new Set(['CUSTOMER', 'MERCHANT', 'DRIVER', 'FLEET_OWNER', 'ADMIN']);

class OtpError extends Error {
  constructor(code, message, status, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function normalizeApp(appType) {
  const value = String(appType || 'CUSTOMER').toUpperCase();
  return APPS.has(value) ? value : 'CUSTOMER';
}

function pepper() {
  const secret = process.env.OTP_HASH_SECRET || '';
  if (secret.length < 32) {
    throw new OtpError('OTP_NOT_CONFIGURED', 'OTP verification is not configured.', 503);
  }
  return secret;
}

function hashCode(challengeId, phone, appType, code) {
  return crypto.createHmac('sha256', pepper())
    .update(`${challengeId}|${phone}|${appType}|${code}`)
    .digest('hex');
}

function timingSafeMatch(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function maskPhone(phone) {
  return `******${phone.slice(-4)}`;
}

function deliveryMode() {
  if (process.env.OTP_DELIVERY_WEBHOOK_URL) return 'WEBHOOK';
  if (process.env.NODE_ENV !== 'production' || process.env.VAAYU_OTP_CONSOLE === 'true') return 'CONSOLE';
  return 'NONE';
}

function sealKey() {
  return crypto.createHash('sha256').update(`otp-console|${pepper()}`).digest();
}

function sealCode(code) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const data = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function openCode(sealed) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(), Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
}

function deliverViaWebhook(phone, code, appType, challengeId) {
  const url = process.env.OTP_DELIVERY_WEBHOOK_URL;
  const secret = process.env.OTP_DELIVERY_WEBHOOK_SECRET || '';
  const target = new URL(url);
  if (process.env.NODE_ENV === 'production' && target.protocol !== 'https:') {
    return Promise.reject(new OtpError('OTP_NOT_CONFIGURED', 'OTP delivery must use HTTPS in production.', 503));
  }
  if (process.env.NODE_ENV === 'production' && secret.length < 32) {
    return Promise.reject(new OtpError('OTP_NOT_CONFIGURED', 'OTP delivery secret is not configured.', 503));
  }
  const body = Buffer.from(JSON.stringify({
    to: `+91${phone}`,
    app: appType,
    challengeId,
    template: 'VAAYU_OTP',
    code,
    expiresInSeconds: Math.floor(TTL_MS / 1000),
  }));
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  return new Promise((resolve, reject) => {
    const req = https.request(target, {
      method: 'POST',
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'X-Vaayu-Timestamp': timestamp,
        'X-Vaayu-Signature': signature,
        'Idempotency-Key': challengeId,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300
        ? resolve({ providerStatus: res.statusCode })
        : reject(new OtpError('OTP_DELIVERY_FAILED', `SMS provider returned ${res.statusCode}.`, 502))));
    });
    req.on('timeout', () => req.destroy(new OtpError('OTP_DELIVERY_FAILED', 'SMS provider timed out.', 502)));
    req.on('error', () => reject(new OtpError('OTP_DELIVERY_FAILED', 'SMS provider unreachable.', 502)));
    req.end(body);
  });
}

function store() {
  const data = db.getDb();
  if (!Array.isArray(data.otp_challenges)) data.otp_challenges = [];
  return data;
}

class OtpChallengeService {
  mode() {
    return deliveryMode();
  }

  // Creates a challenge and delivers the code. Returns metadata only, never the code.
  async send({ phone, appType = 'CUSTOMER', purpose = 'LOGIN', ip = '' }) {
    const cleanPhone = normalizePhone(phone);
    if (cleanPhone.length !== 10) throw new OtpError('INVALID_PHONE', 'Please enter a valid 10-digit mobile number.', 400);
    const app = normalizeApp(appType);
    const mode = deliveryMode();
    if (mode === 'NONE') throw new OtpError('OTP_NOT_CONFIGURED', 'OTP delivery is not configured on this server.', 503);

    const now = Date.now();
    const data = store();
    data.otp_challenges = data.otp_challenges.filter((c) => now - c.createdAtMs < RETENTION_MS);
    const phoneChallenges = data.otp_challenges
      .filter((c) => c.phone === cleanPhone)
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    const latest = phoneChallenges[0];
    if (latest && now - latest.createdAtMs < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - latest.createdAtMs)) / 1000);
      throw new OtpError('RESEND_COOLDOWN', `Please wait ${wait} seconds before requesting another code.`, 429, { retryAfterSeconds: wait });
    }
    const hourAgo = now - 60 * 60 * 1000;
    if (phoneChallenges.filter((c) => c.createdAtMs > hourAgo).length >= MAX_SENDS_PER_HOUR) {
      throw new OtpError('SEND_LIMIT', 'Too many codes requested for this number. Try again later.', 429);
    }

    const code = String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
    const id = `otp_${crypto.randomUUID()}`;
    const challenge = {
      id,
      phone: cleanPhone,
      app,
      purpose: String(purpose || 'LOGIN').toUpperCase(),
      channel: mode,
      codeHash: hashCode(id, cleanPhone, app, code),
      ...(mode === 'CONSOLE' ? { revealed: sealCode(code) } : {}),
      attempts: 0,
      status: 'PENDING',
      deliveryStatus: 'QUEUED',
      createdAtMs: now,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TTL_MS).toISOString(),
      requestIp: String(ip || '').slice(0, 64),
    };
    data.otp_challenges.push(challenge);
    db.saveDb(data);

    try {
      const result = mode === 'WEBHOOK'
        ? await deliverViaWebhook(cleanPhone, code, app, id)
        : { providerStatus: null };
      this.setDelivery(id, mode === 'CONSOLE' ? 'CONSOLE' : 'SENT', result.providerStatus);
    } catch (error) {
      this.setDelivery(id, 'FAILED', null, error.message);
      this.invalidate(id);
      if (error instanceof OtpError) throw error;
      throw new OtpError('OTP_DELIVERY_FAILED', 'OTP delivery is temporarily unavailable.', 502);
    }

    return {
      challengeId: id,
      maskedPhone: maskPhone(cleanPhone),
      app,
      expiresAt: challenge.expiresAt,
      resendAfterSeconds: RESEND_COOLDOWN_MS / 1000,
    };
  }

  setDelivery(id, status, providerStatus = null, error = null) {
    const data = store();
    const row = data.otp_challenges.find((c) => c.id === id);
    if (!row) return;
    row.deliveryStatus = status;
    row.providerStatus = providerStatus;
    row.deliveryError = error ? String(error).slice(0, 200) : null;
    row.deliveryAt = new Date().toISOString();
    db.saveDb(data);
  }

  invalidate(id) {
    const data = store();
    const row = data.otp_challenges.find((c) => c.id === id);
    if (row) {
      row.status = 'INVALIDATED';
      delete row.revealed;
    }
    db.saveDb(data);
  }

  // Verifies a code against the newest pending challenge for this phone. Only one live code
  // exists per phone at a time, so the app label does not change which code is checked.
  // Each wrong attempt is counted and saved before the response is sent.
  verify({ phone, code }) {
    const cleanPhone = normalizePhone(phone);
    const submitted = String(code || '').trim();
    if (!/^\d{6}$/.test(submitted)) throw new OtpError('INVALID_CODE', 'Please enter the 6-digit code.', 400);

    const now = Date.now();
    const data = store();
    const challenge = data.otp_challenges
      .filter((c) => c.phone === cleanPhone && c.status === 'PENDING')
      .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
    if (!challenge) throw new OtpError('INVALID_CODE', 'Invalid or expired code.', 401);

    if (now > Date.parse(challenge.expiresAt)) {
      challenge.status = 'EXPIRED';
      delete challenge.revealed;
      db.saveDb(data);
      throw new OtpError('CODE_EXPIRED', 'This code has expired. Request a new one.', 401);
    }
    if (challenge.attempts >= MAX_ATTEMPTS) {
      challenge.status = 'LOCKED';
      delete challenge.revealed;
      db.saveDb(data);
      throw new OtpError('TOO_MANY_ATTEMPTS', 'Too many incorrect attempts. Request a new code.', 429);
    }

    challenge.attempts += 1;
    const expectedHash = hashCode(challenge.id, cleanPhone, challenge.app, submitted);
    if (!timingSafeMatch(expectedHash, challenge.codeHash)) {
      if (challenge.attempts >= MAX_ATTEMPTS) {
        challenge.status = 'LOCKED';
        delete challenge.revealed;
      }
      db.saveDb(data);
      const left = Math.max(0, MAX_ATTEMPTS - challenge.attempts);
      throw new OtpError('INVALID_CODE', 'Invalid or expired code.', 401, { attemptsRemaining: left });
    }

    challenge.status = 'VERIFIED';
    challenge.verifiedAt = new Date(now).toISOString();
    delete challenge.revealed;
    db.saveDb(data);
    return { challengeId: challenge.id, phone: cleanPhone, app: challenge.app, purpose: challenge.purpose };
  }

  // Checks that a challenge was verified for this phone recently and has not already
  // been used to register. Consumes it, so one verification can only create one application.
  consumeVerification(id, phone) {
    const cleanPhone = normalizePhone(phone);
    const data = store();
    const row = data.otp_challenges.find((c) => c.id === id);
    if (!row || row.status !== 'VERIFIED' || row.phone !== cleanPhone) return false;
    if (row.consumedFor) return false;
    if (Date.now() - Date.parse(row.verifiedAt) > 15 * 60 * 1000) return false;
    row.consumedFor = 'DRIVER_REGISTRATION';
    db.saveDb(data);
    return true;
  }

  recordSignIn(id, role) {
    const data = store();
    const row = data.otp_challenges.find((c) => c.id === id);
    if (!row) return;
    row.signedInRole = String(role || '').slice(0, 32);
    db.saveDb(data);
  }

  // Operator view. Codes are included only for CONSOLE challenges that are still usable.
  listForOperator({ limit = 100, app = null, status = null } = {}) {
    const now = Date.now();
    return store().otp_challenges
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((c) => {
        const effective = c.status === 'PENDING' && now > Date.parse(c.expiresAt) ? 'EXPIRED' : c.status;
        const usable = effective === 'PENDING' && Boolean(c.revealed);
        return {
          id: c.id,
          app: c.app,
          signedInRole: c.signedInRole || null,
          purpose: c.purpose,
          channel: c.channel,
          maskedPhone: maskPhone(c.phone),
          status: effective,
          attempts: c.attempts,
          maxAttempts: MAX_ATTEMPTS,
          deliveryStatus: c.deliveryStatus,
          deliveryError: c.deliveryError || null,
          code: usable ? openCode(c.revealed) : null,
          createdAt: c.createdAt,
          expiresAt: c.expiresAt,
          verifiedAt: c.verifiedAt || null,
          remainingSeconds: Math.max(0, Math.floor((Date.parse(c.expiresAt) - now) / 1000)),
        };
      })
      .filter((r) => (!app || r.app === app) && (!status || r.status === status))
      .slice(0, Math.min(Number(limit) || 100, 500));
  }

  summary() {
    const rows = this.listForOperator({ limit: 500 });
    const count = (predicate) => rows.filter(predicate).length;
    return {
      total: rows.length,
      pending: count((r) => r.status === 'PENDING'),
      verified: count((r) => r.status === 'VERIFIED'),
      expired: count((r) => r.status === 'EXPIRED'),
      locked: count((r) => r.status === 'LOCKED'),
      deliveryFailed: count((r) => r.deliveryStatus === 'FAILED'),
    };
  }
}

const otpChallenges = new OtpChallengeService();

module.exports = { OtpChallengeService, otpChallenges, OtpError, normalizePhone, normalizeApp, MAX_ATTEMPTS, TTL_MS };
