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

  async _incrementWindow(key, windowSec) {
    try {
      const result = await withTimeout(this.redis.eval(RATE_LIMIT_SCRIPT, 1, key, windowSec), 1500);
      const count = Number(Array.isArray(result) ? result[0] : NaN);
      const ttl = Number(Array.isArray(result) ? result[1] : NaN);
      if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(ttl) || ttl < 0) {
        throw new Error('Redis returned an invalid rate-limit result.');
      }
      return { count, resetSec: ttl };
    } catch (err) {
      // The in-memory development engine intentionally does not implement EVAL.
      if (err && err.message === 'EVAL_UNSUPPORTED_BY_MEMORY_ENGINE') {
        const count = await withTimeout(this.redis.incr(key), 1500);
        if (count === 1) await withTimeout(this.redis.expire(key, windowSec), 1500);
        return { count, resetSec: windowSec };
      }
      throw err;
    }
  }

  async checkRateLimit(req, res, routeName = 'default', customMax = null, customWindow = null) {
    const config = this.ROUTE_CONFIGS[routeName] || this.ROUTE_CONFIGS.default;
    const maxRequests = customMax ?? config.maxRequests;
    const windowSec = customWindow ?? config.windowSec;
    const identifier = this.getIdentifier(req);
    const key = `${this.KEY_PREFIX}${routeName}:${identifier}`;

    try {
      const { count: currentCount, resetSec } = await this._incrementWindow(key, windowSec);
      const remaining = Math.max(0, maxRequests - currentCount);
      if (res && typeof res.setHeader === 'function') {
        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', remaining);
        res.setHeader('X-RateLimit-Reset', resetSec);
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
          resetSec
        };
      }
      return { allowed: true, limit: maxRequests, current: currentCount, remaining, resetSec };
    } catch (err) {
      logger.warn('rate_limit_unavailable', `Rate limiter unavailable: ${err.message}`, { routeName });
      return { allowed: true, error: err.message };
    }
  }

  async disconnect() {
    if (this.redis && typeof this.redis.disconnect === 'function') await this.redis.disconnect();
  }
}

const redisRateLimiter = new RedisRateLimiter();

module.exports = { RedisRateLimiter, redisRateLimiter, RATE_LIMIT_SCRIPT };
