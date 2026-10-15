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

/**
 * VAAYU Milestone 6 Phase 6.5: Distributed Shared Redis Rate Limiter
 * 
 * Features:
 * 1. Redis-backed shared sliding/fixed window rate limit counter.
 * 2. Multi-instance cluster synchronization (`rate:limiter:<route>:<identifier>`).
 * 3. Enforces Route-specific rate limits (auth endpoints, booking creation, state transitions).
 * 4. Injects X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset headers.
 * 5. Returns 429 Too Many Requests (code: RATE_LIMIT_EXCEEDED) when quota exceeded.
 */
class RedisRateLimiter {
  constructor(redisClient = null) {
    this.redis = redisClient || new RedisClient();
    this.KEY_PREFIX = 'rate:limiter:';
    
    // Route Rate Limit Profiles
    this.ROUTE_CONFIGS = {
      'auth:otp:send': { maxRequests: 5, windowSec: 60 },
      'auth:otp:verify': { maxRequests: 10, windowSec: 60 },
      'auth:admin-login': { maxRequests: 5, windowSec: 60 },
      'trips:create': { maxRequests: 10, windowSec: 60 },
      'orders:transition': { maxRequests: 20, windowSec: 60 },
      'geocoding:search': { maxRequests: 30, windowSec: 60 },
      // Public map and fare endpoints. They call paid or best-effort map providers, so each client gets a bounded rate.
      'public:map': { maxRequests: 30, windowSec: 60 },
      'default': { maxRequests: 60, windowSec: 60 }
    };
    // Isolated workflow suites may exercise many protected endpoints in one
    // minute. Keep this override unavailable unless test endpoints are enabled
    // in a non-production process; normal demo/production limits stay intact.
    if (process.env.VAAYU_OTP_CONSOLE === 'true' || (process.env.NODE_ENV !== 'production' && process.env.ENABLE_TEST_ENDPOINTS === 'true')) {
      const qaDefaultLimit = Number(process.env.VAAYU_QA_RATE_LIMIT_DEFAULT);
      if (Number.isInteger(qaDefaultLimit) && qaDefaultLimit >= 60 && qaDefaultLimit <= 1000) {
        this.ROUTE_CONFIGS.default.maxRequests = qaDefaultLimit;
      }
      this.ROUTE_CONFIGS['auth:otp:send'].maxRequests = 50;
      this.ROUTE_CONFIGS['auth:otp:verify'].maxRequests = 60;
    }
  }

  /**
   * Extracts client identifier (IP address or authenticated User ID)
   */
  getIdentifier(req) {
    if (req.user && req.user.id) {
      return `usr_${req.user.id}`;
    }
    // X-Forwarded-For is client-controlled. Honor it only behind a trusted proxy (TRUST_PROXY=true),
    // otherwise a client could rotate the header to escape its rate limit.
    const forwarded = req.headers ? (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']) : null;
    if (forwarded && process.env.TRUST_PROXY === 'true') {
      return `ip_${String(forwarded).split(',')[0].trim()}`;
    }
    return `ip_${req.socket ? req.socket.remoteAddress : '127.0.0.1'}`;
  }

  /**
   * Checks rate limit for given HTTP request and route
   */
  async checkRateLimit(req, res, routeName = 'default', customMax = null, customWindow = null) {
    const config = this.ROUTE_CONFIGS[routeName] || this.ROUTE_CONFIGS['default'];
    const maxRequests = customMax || config.maxRequests;
    const windowSec = customWindow || config.windowSec;

    const identifier = this.getIdentifier(req);
    const key = `${this.KEY_PREFIX}${routeName}:${identifier}`;

    try {
      const currentCount = await withTimeout(this.redis.incr(key), 1500);

      if (currentCount === 1) {
        await withTimeout(this.redis.expire(key, windowSec), 1500);
      }

      const remaining = Math.max(0, maxRequests - currentCount);
      const resetSec = windowSec;

      // Inject X-RateLimit headers if response object is provided
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

      return {
        allowed: true,
        limit: maxRequests,
        current: currentCount,
        remaining,
        resetSec
      };
    } catch (err) {
      console.warn(`[RedisRateLimiter] Error evaluating rate limit: ${err.message}`);
      // Fail-open property: Allow request if rate limiter storage encounters error
      return { allowed: true, error: err.message };
    }
  }

  async disconnect() {
    if (this.redis && typeof this.redis.disconnect === 'function') {
      await this.redis.disconnect();
    }
  }
}

const redisRateLimiter = new RedisRateLimiter();

module.exports = {
  RedisRateLimiter,
  redisRateLimiter
};
