'use strict';

const { RedisClient } = require('./redisClient');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis command timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Atomic fixed-window counter. Keeping INCR and the first EXPIRE in one Redis script
// prevents a partial failure from leaving a counter without a TTL forever.
const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

class RedisRateLimiter {
  constructor(redisClient = null) {
    this.redis = redisClient || new RedisClient();
    this.KEY_PREFIX = 'rate:limiter:';
    this.ROUTE_CONFIGS = {
      'auth:otp:send': { maxRequests: 5, windowSec: 60 },
      'auth:otp:verify': { maxRequests: 10, windowSec: 60 },
      'auth:admin-login': { maxRequests: 5, windowSec: 60 },
      'trips:create': { maxRequests: 10, windowSec: 60 },
      'orders:transition': { maxRequests: 20, windowSec: 60 },
      'geocoding:search': { maxRequests: 30, windowSec: 60 },
      'public:map': { maxRequests: 30, windowSec: 60 },
      'default': { maxRequests: 60, windowSec: 60 }
    };

    // Redis is the authoritative distributed limiter in production. If it becomes
    // unavailable, keep a bounded per-process window rather than silently failing open.
    // A hard capacity limit also prevents an attacker from turning degraded mode into
    // an unbounded memory-growth vector by generating arbitrary identifiers.
    this.fallbackWindows = new Map();
    this.maxFallbackEntries = 10000;

    if (process.env.VAAYU_OTP_CONSOLE === 'true' || (process.env.NODE_ENV !== 'production' && process.env.ENABLE_TEST_ENDPOINTS === 'true')) {
      const qaDefaultLimit = Number(process.env.VAAYU_QA_RATE_LIMIT_DEFAULT);
      if (Number.isInteger(qaDefaultLimit) && qaDefaultLimit >= 60 && qaDefaultLimit <= 1000) {
        this.ROUTE_CONFIGS.default.maxRequests = qaDefaultLimit;
      }
      this.ROUTE_CONFIGS['auth:otp:send'].maxRequests = 50;
      this.ROUTE_CONFIGS['auth:otp:verify'].maxRequests = 60;
    }
  }

  getIdentifier(req) {
    if (req.user && req.user.id) return `usr_${req.user.id}`;
    const forwarded = req.headers ? (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']) : null;
    if (forwarded && process.env.TRUST_PROXY === 'true') {
      return `ip_${String(forwarded).split(',')[0].trim()}`;
    }
    return `ip_${req.socket ? req.socket.remoteAddress : '127.0.0.1'}`;
  }

  _incrementFallbackWindow(key, windowSec) {
    const now = Date.now();
    const existing = this.fallbackWindows.get(key);

    if (existing && existing.expiresAt > now) {
      existing.count += 1;
      return {
        count: existing.count,
        resetSec: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)),
        degraded: true
      };
    }

    if (existing) this.fallbackWindows.delete(key);

    // Opportunistically reclaim expired entries. If the bounded store is still full,
    // reject a new key rather than evicting a live client's quota and creating a bypass.
    if (this.fallbackWindows.size >= this.maxFallbackEntries) {
      for (const [entryKey, entry] of this.fallbackWindows) {
        if (entry.expiresAt <= now) this.fallbackWindows.delete(entryKey);
      }
      if (this.fallbackWindows.size >= this.maxFallbackEntries) {
        const error = new Error('Rate limiter fallback capacity exhausted.');
        error.code = 'RATE_LIMIT_FALLBACK_CAPACITY_EXHAUSTED';
        throw error;
      }
    }

    const expiresAt = now + (windowSec * 1000);
    this.fallbackWindows.set(key, { count: 1, expiresAt });
    return { count: 1, resetSec: Math.max(1, windowSec), degraded: true };
  }

  async _incrementWindow(key, windowSec) {
    try {
      const result = await withTimeout(this.redis.eval(RATE_LIMIT_SCRIPT, 1, key, windowSec), 1500);
      const count = Number(Array.isArray(result) ? result[0] : NaN);
      const ttl = Number(Array.isArray(result) ? result[1] : NaN);
      if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(ttl) || ttl < 0) {
        throw new Error('Redis returned an invalid rate-limit result.');
      }
      return { count, resetSec: ttl, degraded: false };
    } catch (err) {
      // The in-memory development engine intentionally does not implement EVAL.
      if (err && err.message === 'EVAL_UNSUPPORTED_BY_MEMORY_ENGINE') {
        const count = await withTimeout(this.redis.incr(key), 1500);
        if (count === 1) await withTimeout(this.redis.expire(key, windowSec), 1500);
        return { count, resetSec: windowSec, degraded: false };
      }

      // Real Redis failures use a bounded local window. This preserves a meaningful
      // quota during an outage while acknowledging that the fallback is process-local.
      return this._incrementFallbackWindow(key, windowSec);
    }
  }

  async checkRateLimit(req, res, routeName = 'default', customMax = null, customWindow = null) {
    const config = this.ROUTE_CONFIGS[routeName] || this.ROUTE_CONFIGS.default;
    const maxRequests = customMax ?? config.maxRequests;
    const windowSec = customWindow ?? config.windowSec;
    const identifier = this.getIdentifier(req);
    const key = `${this.KEY_PREFIX}${routeName}:${identifier}`;

    try {
      const { count: currentCount, resetSec, degraded } = await this._incrementWindow(key, windowSec);
      const remaining = Math.max(0, maxRequests - currentCount);
      if (res && typeof res.setHeader === 'function') {
        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', remaining);
        res.setHeader('X-RateLimit-Reset', resetSec);
      }
      if (degraded) {
        metricsService.increment('rate_limit_degraded_total');
        logger.warn('rate_limit_degraded', `Using bounded local rate-limit fallback for route ${routeName}`, { routeName });
      }
      if (currentCount > maxRequests) {
        metricsService.increment('rate_limit_rejected_total');
        logger.warn('rate_limit_exceeded', `Rate limit exceeded for route ${routeName}`, { routeName, identifier });
        return {
          allowed: false,
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Too many requests for ${routeName}. Rate limit exceeded (${maxRequests} req / ${windowSec}s)`,
          limit: maxRequests,
          current: currentCount,
          remaining: 0,
          resetSec,
          degraded: Boolean(degraded)
        };
      }
      return { allowed: true, limit: maxRequests, current: currentCount, remaining, resetSec, degraded: Boolean(degraded) };
    } catch (err) {
      logger.error('rate_limit_unavailable', `Rate limiter unavailable: ${err.message}`, { routeName });
      metricsService.increment('rate_limit_fail_closed_total');
      return {
        allowed: false,
        code: err.code || 'RATE_LIMIT_UNAVAILABLE',
        message: 'Rate limiter temporarily unavailable. Please retry shortly.'
      };
    }
  }

  async disconnect() {
    this.fallbackWindows.clear();
    if (this.redis && typeof this.redis.disconnect === 'function') await this.redis.disconnect();
  }
}

const redisRateLimiter = new RedisRateLimiter();

module.exports = { RedisRateLimiter, redisRateLimiter, RATE_LIMIT_SCRIPT };
