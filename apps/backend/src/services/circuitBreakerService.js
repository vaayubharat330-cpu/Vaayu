/**
 * VAAYU Enterprise Logistics Platform
 * Circuit Breaker Resilience Service
 *
 * Implements stateful Circuit Breaker pattern (CLOSED -> OPEN -> HALF_OPEN)
 * to protect backend execution from downstream external API timeouts or network outages.
 */

const { logger } = require('./logger');

class CircuitBreakerService {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeoutMs = options.resetTimeoutMs || 30000; // 30s
    this.breakers = new Map();
  }

  /**
   * Get or initialize breaker state for a named service
   * @param {string} serviceName 
   * @returns {Object} breakerState
   */
  getBreaker(serviceName) {
    if (!this.breakers.has(serviceName)) {
      this.breakers.set(serviceName, {
        state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
        failureCount: 0,
        successCount: 0,
        nextAttemptMs: 0,
        lastFailureTime: null
      });
    }
    return this.breakers.get(serviceName);
  }

  /**
   * Execute an async function wrapped with Circuit Breaker resilience
   * @param {string} serviceName 
   * @param {Function} asyncFn 
   * @param {Function} fallbackFn 
   * @returns {Promise<any>}
   */
  async execute(serviceName, asyncFn, fallbackFn = null) {
    const breaker = this.getBreaker(serviceName);
    const now = Date.now();

    // Check if OPEN state timer has elapsed -> transition to HALF_OPEN
    if (breaker.state === 'OPEN') {
      if (now >= breaker.nextAttemptMs) {
        breaker.state = 'HALF_OPEN';
        logger.info('circuit_breaker_half_open', `Circuit Breaker [${serviceName}] transitioned to HALF_OPEN trial state`);
      } else {
        logger.warn('circuit_breaker_open_rejected', `Circuit Breaker [${serviceName}] is OPEN. Executing fallback.`);
        if (fallbackFn) return await fallbackFn();
        throw new Error(`Circuit Breaker [${serviceName}] is OPEN. Downstream dependency unavailable.`);
      }
    }

    try {
      const result = await asyncFn();
      this.onSuccess(serviceName);
      return result;
    } catch (err) {
      this.onFailure(serviceName, err);
      if (fallbackFn) {
        return await fallbackFn(err);
      }
      throw err;
    }
  }

  onSuccess(serviceName) {
    const breaker = this.getBreaker(serviceName);
    if (breaker.state === 'HALF_OPEN') {
      breaker.state = 'CLOSED';
      breaker.failureCount = 0;
      breaker.successCount = 0;
      logger.info('circuit_breaker_closed', `Circuit Breaker [${serviceName}] recovered and returned to CLOSED state`);
    } else if (breaker.state === 'CLOSED') {
      breaker.failureCount = 0;
    }
  }

  onFailure(serviceName, err) {
    const breaker = this.getBreaker(serviceName);
    breaker.failureCount++;
    breaker.lastFailureTime = Date.now();

    if (breaker.failureCount >= this.failureThreshold || breaker.state === 'HALF_OPEN') {
      breaker.state = 'OPEN';
      breaker.nextAttemptMs = Date.now() + this.resetTimeoutMs;
      logger.error('circuit_breaker_tripped', `Circuit Breaker [${serviceName}] TRIPPED to OPEN state (${breaker.failureCount} failures)`, {
        serviceName,
        error: err.message,
        resetTimeoutMs: this.resetTimeoutMs
      });
    }
  }

  /**
   * Get status of all active circuit breakers
   * @returns {Object}
   */
  getStatus() {
    const statusObj = {};
    this.breakers.forEach((b, name) => {
      statusObj[name] = {
        state: b.state,
        failures: b.failureCount,
        nextAttemptMs: b.nextAttemptMs
      };
    });
    return statusObj;
  }
}

const circuitBreakerService = new CircuitBreakerService();

module.exports = {
  CircuitBreakerService,
  circuitBreakerService
};
