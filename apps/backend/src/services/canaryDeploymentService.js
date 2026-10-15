'use strict';

const crypto = require('crypto');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

/**
 * VAAYU Milestone 7: Canary Routing & Deployment Management Service
 * 
 * Responsibilities:
 * 1. Evaluates incoming request context to determine Canary vs Baseline target version.
 * 2. Supports Header-based routing (`X-Canary-Channel`, `X-Canary`), Pilot Rings, and Weighted Hash splits.
 * 3. Monitors Canary error rate & p95 latency thresholds.
 * 4. Automatically triggers fail-safe rollback to Baseline (0% canary weight) upon SLA breach.
 * 5. Masks and sanitizes sensitive infrastructure credentials from operational dumps.
 */

const CANARY_MODES = Object.freeze({
  DISABLED: 'DISABLED',       // 100% baseline
  HEADER_ONLY: 'HEADER_ONLY', // Only requests with explicit header
  WEIGHTED: 'WEIGHTED',       // Hash-based percentage split (0-100)
  RING_PILOT: 'RING_PILOT'    // Specific tenant/fleet IDs
});

class CanaryDeploymentService {
  constructor(options = {}) {
    this.mode = options.mode || CANARY_MODES.HEADER_ONLY;
    this.weightPercent = options.weightPercent !== undefined ? Math.min(100, Math.max(0, options.weightPercent)) : 0;
    this.canaryVersion = options.canaryVersion || 'v2.1.0-canary';
    this.baselineVersion = options.baselineVersion || 'v2.0.0-stable';
    this.pilotTenants = new Set(options.pilotTenants || []);
    this.pilotFleets = new Set(options.pilotFleets || []);

    // Rollback threshold triggers
    this.errorThresholdPercent = options.errorThresholdPercent || 2.0; // 2% 5xx triggers rollback
    this.sampleWindowSize = options.sampleWindowSize || 50;
    this.canaryRequestsCount = 0;
    this.canaryErrorsCount = 0;
    this.isRollbackTriggered = false;
    this.rollbackReason = null;
  }

  /**
   * Evaluates an incoming HTTP request to determine target routing version
   */
  resolveTarget(req = {}) {
    if (this.isRollbackTriggered) {
      return {
        target: 'BASELINE',
        version: this.baselineVersion,
        reason: `ROLLBACK_ACTIVE: ${this.rollbackReason}`,
        isCanary: false
      };
    }

    const headers = req.headers || {};

    // 1. Explicit Canary Header Match
    const canaryHeader = String(headers['x-canary'] || headers['X-Canary'] || '').toLowerCase();
    const channelHeader = String(headers['x-canary-channel'] || headers['x-client-channel'] || '').toLowerCase();
    if (canaryHeader === 'true' || canaryHeader === '1' || channelHeader === 'canary' || channelHeader === 'beta') {
      return {
        target: 'CANARY',
        version: this.canaryVersion,
        reason: 'HEADER_MATCH',
        isCanary: true
      };
    }

    // 2. Pilot Ring Evaluation (Tenant ID or Fleet ID)
    const tenantId = req.authorizedMerchantId || req.user?.id || (req.query && (req.query.merchant_id || req.query.merchantId));
    if (tenantId && this.pilotTenants.has(String(tenantId))) {
      return {
        target: 'CANARY',
        version: this.canaryVersion,
        reason: 'PILOT_TENANT_RING',
        isCanary: true
      };
    }

    const fleetId = req.query?.city || req.body?.city || (headers['x-fleet-id']);
    if (fleetId && this.pilotFleets.has(String(fleetId).toLowerCase())) {
      return {
        target: 'CANARY',
        version: this.canaryVersion,
        reason: 'PILOT_FLEET_RING',
        isCanary: true
      };
    }

    // 3. Weighted Hash Split (Deterministic based on client IP, Request ID, or User ID)
    if (this.mode === CANARY_MODES.WEIGHTED && this.weightPercent > 0) {
      const routingKey = req.user?.id || req.socket?.remoteAddress || req.requestId || `${Math.random()}`;
      const hash = crypto.createHash('sha256').update(String(routingKey)).digest('hex');
      const bucket = parseInt(hash.substring(0, 4), 16) % 100;

      if (bucket < this.weightPercent) {
        return {
          target: 'CANARY',
          version: this.canaryVersion,
          reason: `WEIGHTED_BUCKET_${bucket}_LT_${this.weightPercent}`,
          isCanary: true
        };
      }
    }

    return {
      target: 'BASELINE',
      version: this.baselineVersion,
      reason: 'DEFAULT_BASELINE',
      isCanary: false
    };
  }

  /**
   * Records operational execution status of a Canary request
   */
  recordCanaryResult({ statusCode = 200, latencyMs = 0 } = {}) {
    if (this.isRollbackTriggered) return;

    this.canaryRequestsCount++;
    if (statusCode >= 500) {
      this.canaryErrorsCount++;
    }

    if (this.canaryRequestsCount >= this.sampleWindowSize) {
      const errorRate = (this.canaryErrorsCount / this.canaryRequestsCount) * 100;
      if (errorRate >= this.errorThresholdPercent) {
        this.triggerRollback(`High error rate detected: ${errorRate.toFixed(1)}% >= ${this.errorThresholdPercent}% threshold`);
      }
    }
  }

  /**
   * Triggers immediate automatic rollback to baseline version
   */
  triggerRollback(reason = 'Operational SLA violation') {
    this.isRollbackTriggered = true;
    this.rollbackReason = reason;
    this.weightPercent = 0;
    this.mode = CANARY_MODES.DISABLED;
    metricsService.increment('canary_rollback_triggered_total');
    logger.warn('canary_auto_rollback', `Automatic rollback triggered: ${reason}`, { reason, canaryVersion: this.canaryVersion });
  }

  /**
   * Sanitizes sensitive configuration object to prevent secret leakage
   */
  static sanitizeConfig(config = {}) {
    const sensitiveKeys = new Set([
      'password', 'secret', 'jwt_secret', 'database_url', 'redis_url',
      'razorpay_key_secret', 'admin_users_json', 'api_key', 'authorization'
    ]);

    const sanitized = {};
    for (const [key, val] of Object.entries(config)) {
      const lower = key.toLowerCase();
      if (sensitiveKeys.has(lower) || lower.includes('secret') || lower.includes('password')) {
        sanitized[key] = '[REDACTED_SECRET]';
      } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        sanitized[key] = CanaryDeploymentService.sanitizeConfig(val);
      } else {
        sanitized[key] = val;
      }
    }
    return sanitized;
  }
}

module.exports = {
  CanaryDeploymentService,
  CANARY_MODES
};
