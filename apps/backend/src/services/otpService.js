const crypto = require('crypto');
const https = require('https');
const { RedisClient } = require('./redisClient');
const db = require('../db/database');

class OtpService {
  constructor() {
    this.store = process.env.NODE_ENV === 'production' ? new RedisClient() : null;
    this.pending = new Map();
    this.ttlMs = 5 * 60 * 1000;
    this.maxAttempts = 5;
    this.smsInbox = [];
  }

  digest(phone, code) {
    const pepper = process.env.OTP_HASH_SECRET || '';
    if (pepper.length < 32) throw new Error('OTP_HASH_SECRET must be configured with at least 32 characters');
    return crypto.createHmac('sha256', pepper).update(`${phone}:${code}`).digest('hex');
  }

  async deliver(phone, code) {
    const webhook = process.env.OTP_DELIVERY_WEBHOOK_URL;
    if (!webhook) {
      if (process.env.NODE_ENV === 'production') throw new Error('OTP delivery is not configured');
      return { delivered: true, demo: true };
    }
    const target = new URL(webhook);
    if (target.protocol !== 'https:') throw new Error('OTP delivery webhook must use HTTPS');
    const payload = Buffer.from(JSON.stringify({ phone, code, expiresInSeconds: Math.floor(this.ttlMs / 1000) }));
    const secret = process.env.OTP_DELIVERY_WEBHOOK_SECRET || '';
    if (process.env.NODE_ENV === 'production' && secret.length < 32) throw new Error('OTP_DELIVERY_WEBHOOK_SECRET must be at least 32 characters in production');
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    await new Promise((resolve, reject) => {
      const req = https.request(target, {
        method: 'POST', timeout: 5000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'X-VAAYU-Signature': signature }
      }, res => {
        res.resume();
        res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`OTP provider returned ${res.statusCode}`)));
      });
      req.on('timeout', () => req.destroy(new Error('OTP provider timed out')));
      req.on('error', reject);
      req.end(payload);
    });
    return { delivered: true, demo: false };
  }

  async issue(phone, appType = 'CUSTOMER') {
    const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
    const code = String(crypto.randomInt(100000, 1000000));
    if (this.store) {
      await this.store.set(`vaayu:otp:${cleanPhone}`, this.digest(cleanPhone, code), 'EX', Math.floor(this.ttlMs / 1000));
      await this.store.del(`vaayu:otp-attempts:${cleanPhone}`);
    } else {
      this.pending.set(cleanPhone, { digest: this.digest(cleanPhone, code), expiresAt: Date.now() + this.ttlMs, attempts: 0 });
    }
    await this.deliver(cleanPhone, code);
    
    const now = new Date();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const smsEntry = {
      id: `sms_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      phone: cleanPhone,
      code,
      appType: String(appType || 'CUSTOMER').toUpperCase(),
      sender: 'TX-VAAYU',
      message: `Your VAAYU verification code is ${code}. Valid for 5 minutes. Do not share this OTP with anyone. - VAAYU Logistics`,
      verified: false,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    };

    this.smsInbox.unshift(smsEntry);
    if (this.smsInbox.length > 200) this.smsInbox.pop();

    try {
      if (process.env.NODE_ENV === 'production') throw new Error('plaintext OTP persistence is development-only');
      const dbData = db.getDb();
      if (!dbData.otpRequests) dbData.otpRequests = [];
      if (!dbData.otp_sms_log) dbData.otp_sms_log = [];
      dbData.otpRequests.push({
        phone: cleanPhone,
        otp: code,
        appType: smsEntry.appType,
        expiresAt: expiresAt.toISOString(),
        createdAt: now.toISOString()
      });
      dbData.otp_sms_log.unshift(smsEntry);
      if (dbData.otp_sms_log.length > 200) dbData.otp_sms_log.pop();
      db.saveDb(dbData);
    } catch (_) {}
    
    const isDevMode = process.env.NODE_ENV !== 'production' && process.env.VAAYU_EXPOSE_DEV_OTP !== 'false';
    return { demoOtp: isDevMode ? code : undefined, smsEntry };
  }

  recordDeliveryOtp(phone, code, tripId, appType = 'TRIP_DELIVERY') {
    const cleanPhone = String(phone || '9999999999').replace(/\D/g, '').slice(-10);
    const codeStr = String(code);
    const now = new Date();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour for delivery
    const smsEntry = {
      id: `sms_del_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      phone: cleanPhone,
      code: codeStr,
      appType: 'TRIP_DELIVERY',
      tripId: String(tripId),
      sender: 'TX-VAAYU',
      message: `Your VAAYU delivery verification PIN is ${codeStr} for Order #${tripId}. Share with driver only upon receiving goods safely. - VAAYU Logistics`,
      verified: false,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    this.smsInbox.unshift(smsEntry);
    if (this.smsInbox.length > 200) this.smsInbox.pop();
    try {
      const dbData = db.getDb();
      if (!dbData.otp_sms_log) dbData.otp_sms_log = [];
      dbData.otp_sms_log.unshift(smsEntry);
      if (dbData.otp_sms_log.length > 200) dbData.otp_sms_log.pop();
      db.saveDb(dbData);
    } catch (_) {}
    return smsEntry;
  }

  markTripOtpVerified(tripId, code) {
    const codeStr = String(code || '').trim();
    const tripIdStr = String(tripId || '');
    const match = this.smsInbox.find(m => (m.tripId === tripIdStr || !tripIdStr) && (m.code === codeStr || !codeStr));
    if (match) {
      match.verified = true;
      match.verifiedAt = new Date().toISOString();
    }
    try {
      const dbData = db.getDb();
      if (dbData && dbData.otp_sms_log) {
        const dbMatch = dbData.otp_sms_log.find(m => (m.tripId === tripIdStr || !tripIdStr) && (m.code === codeStr || !codeStr));
        if (dbMatch) {
          dbMatch.verified = true;
          dbMatch.verifiedAt = new Date().toISOString();
          db.saveDb(dbData);
        }
      }
    } catch (_) {}
  }

  getInbox() {
    const nowMs = Date.now();
    return this.smsInbox.map(item => {
      const remainingSec = Math.max(0, Math.floor((new Date(item.expiresAt).getTime() - nowMs) / 1000));
      let status = 'ACTIVE';
      if (item.verified) status = 'VERIFIED';
      else if (remainingSec === 0) status = 'EXPIRED';

      return {
        ...item,
        remainingSeconds: remainingSec,
        status
      };
    });
  }

  clearInbox() {
    this.smsInbox = [];
    try {
      const dbData = db.getDb();
      dbData.otpRequests = [];
      dbData.otp_sms_log = [];
      db.saveDb(dbData);
    } catch (_) {}
    return { success: true };
  }

  async verify(phone, code) {
    const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
    const codeStr = String(code || '').trim();

    const markMatchingVerified = () => {
      const match = this.smsInbox.find(m => m.phone === cleanPhone && (m.code === codeStr || !codeStr));
      if (match) {
        match.verified = true;
        match.verifiedAt = new Date().toISOString();
      }
      try {
        const dbData = db.getDb();
        if (dbData && dbData.otp_sms_log) {
          const dbMatch = dbData.otp_sms_log.find(m => m.phone === cleanPhone && (m.code === codeStr || !codeStr));
          if (dbMatch) {
            dbMatch.verified = true;
            dbMatch.verifiedAt = new Date().toISOString();
            db.saveDb(dbData);
          }
        }
      } catch (_) {}
    };

    if (!this.store) {
      const entry = this.pending.get(cleanPhone);
      if (!entry || entry.expiresAt <= Date.now() || entry.attempts >= this.maxAttempts) {
        this.pending.delete(cleanPhone);
        return false;
      }
      entry.attempts += 1;
      const actual = Buffer.from(this.digest(cleanPhone, codeStr));
      const expected = Buffer.from(entry.digest);
      const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
      if (valid) {
        this.pending.delete(cleanPhone);
        markMatchingVerified();
      }
      return valid;
    }
    const key = `vaayu:otp:${cleanPhone}`;
    const entry = await this.store.get(key);
    if (!entry) return false;
    const attempts = await this.store.incr(`vaayu:otp-attempts:${cleanPhone}`);
    if (attempts === 1) await this.store.expire(`vaayu:otp-attempts:${cleanPhone}`, Math.floor(this.ttlMs / 1000));
    if (attempts > this.maxAttempts) { await this.store.del(key); return false; }
    const actual = Buffer.from(this.digest(cleanPhone, codeStr));
    const expected = Buffer.from(entry);
    const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    if (valid) {
      await this.store.del(key);
      await this.store.del(`vaayu:otp-attempts:${cleanPhone}`);
      markMatchingVerified();
    }
    return valid;
  }
}

module.exports = { OtpService, otpService: new OtpService() };
