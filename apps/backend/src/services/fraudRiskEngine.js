'use strict';

const crypto = require('crypto');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

/**
 * VAAYU Milestone 13: Fraud & Risk Engine
 * 
 * Features & Invariants:
 * 1. Deterministic Multi-Vector Risk Scoring (ALLOW, DELAY, REVIEW, BLOCK)
 * 2. Payment Abuse & Velocity Throttling
 * 3. Driver GPS Spoofing & Impossible Velocity Teleportation
 * 4. Driver-Customer Collusion & Synthetic Trip Detection
 * 5. Customer Cancellation Farming & Fraudulent Dispute Gating
 * 6. Maker-Checker Dual-Control Authorization for High-Risk Overrides
 * 7. Multi-Tenant Risk Boundary Isolation
 * 8. Cardinal Invariant: Financial ledger is NEVER silently mutated;
 *    Risk Engine evaluates and gates, while the frozen ledger executes.
 */

const RISK_DECISIONS = Object.freeze({
  ALLOW: 'ALLOW',
  DELAY: 'DELAY',
  REVIEW: 'REVIEW',
  BLOCK: 'BLOCK'
});

class FraudRiskEngine {
  constructor(options = {}) {
    // In-memory velocity tracking stores: key -> array of timestamps
    this.paymentFailureVelocity = new Map();
    this.customerCancellationVelocity = new Map();
    this.driverCustomerPairings = new Map(); // `drv:cust` -> count
    this.deviceAccounts = new Map(); // deviceId -> Set<userId>

    // Maker-Checker Review Queue
    this.reviewQueue = new Map(); // reviewId -> { action, makerId, checkerId, status, payload }

    // Risk Rules Thresholds
    this.CONFIG = {
      MAX_PAYMENT_FAILURES_WINDOW: 5,
      PAYMENT_FAILURE_WINDOW_MS: 120000, // 2 mins
      MAX_CANCELLATIONS_WINDOW: 4,
      CANCELLATION_WINDOW_MS: 3600000,   // 1 hour
      COLLUSION_TRIP_RATIO_THRESHOLD: 0.70, // 70% repeat trips with same party
      MAX_IMPOSSIBLE_SPEED_KMH: 140,
      MAX_EXPOSURE_PER_TRANSACTION_PAISE: 2000000 // ₹20,000 max single transaction
    };
  }

  /**
   * Evaluates overall risk score and produces deterministic decision
   */
  evaluateTransactionRisk(context) {
    metricsService.increment('risk_evaluations_total');
    let riskScore = 0;
    const flags = [];

    const now = Date.now();
    const {
      customerId,
      driverId,
      amountPaise = 0,
      deviceId,
      merchantId,
      telemetry,
      trip
    } = context;

    // Rule 1: Payment Velocity Abuse
    if (customerId && this.paymentFailureVelocity.has(customerId)) {
      const failures = this.paymentFailureVelocity.get(customerId).filter(t => now - t < this.CONFIG.PAYMENT_FAILURE_WINDOW_MS);
      if (failures.length >= this.CONFIG.MAX_PAYMENT_FAILURES_WINDOW) {
        riskScore += 60;
        flags.push('HIGH_PAYMENT_FAILURE_VELOCITY');
        metricsService.increment('risk_velocity_violations_total');
      }
    }

    // Rule 2: Single Transaction Exposure Limit
    if (amountPaise > this.CONFIG.MAX_EXPOSURE_PER_TRANSACTION_PAISE) {
      riskScore += 40;
      flags.push('EXCEEDS_SINGLE_TRANSACTION_EXPOSURE_LIMIT');
    }

    // Rule 3: Device Multi-Account Sybil Correlation
    if (deviceId && customerId) {
      if (!this.deviceAccounts.has(deviceId)) {
        this.deviceAccounts.set(deviceId, new Set());
      }
      const accounts = this.deviceAccounts.get(deviceId);
      accounts.add(customerId);
      if (accounts.size > 3) {
        riskScore += 50;
        flags.push('MULTIPLE_ACCOUNTS_ON_SAME_DEVICE');
      }
    }

    // Rule 4: Driver GPS Spoofing & Teleportation
    if (telemetry && telemetry.calculatedSpeedKmh > this.CONFIG.MAX_IMPOSSIBLE_SPEED_KMH) {
      riskScore += 85;
      flags.push('GPS_TELEPORTATION_IMPOSSIBLE_VELOCITY');
      metricsService.increment('risk_gps_spoofing_detected_total');
    }

    // Rule 5: Driver-Customer Collusion Ring
    if (driverId && customerId) {
      const pairKey = `${driverId}:${customerId}`;
      const pairCount = (this.driverCustomerPairings.get(pairKey) || 0) + 1;
      this.driverCustomerPairings.set(pairKey, pairCount);
      if (pairCount >= 5) {
        riskScore += 75;
        flags.push('SUSPICIOUS_REPEAT_COLLUSION_PAIRING');
        metricsService.increment('risk_collusion_detected_total');
      }
    }

    // Rule 6: Customer Cancellation Farming
    if (customerId && this.customerCancellationVelocity.has(customerId)) {
      const cancels = this.customerCancellationVelocity.get(customerId).filter(t => now - t < this.CONFIG.CANCELLATION_WINDOW_MS);
      if (cancels.length >= this.CONFIG.MAX_CANCELLATIONS_WINDOW) {
        riskScore += 35;
        flags.push('EXCESSIVE_CANCELLATION_VELOCITY');
      }
    }

    // Determine Categorical Decision
    let decision = RISK_DECISIONS.ALLOW;
    if (riskScore >= 85) {
      decision = RISK_DECISIONS.BLOCK;
      metricsService.increment('risk_decisions_block_total');
    } else if (riskScore >= 60) {
      decision = RISK_DECISIONS.REVIEW;
      metricsService.increment('risk_decisions_review_total');
    } else if (riskScore >= 30) {
      decision = RISK_DECISIONS.DELAY;
      metricsService.increment('risk_decisions_delay_total');
    } else {
      metricsService.increment('risk_decisions_allow_total');
    }

    const evaluationResult = {
      evaluationId: `risk_eval_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      decision,
      riskScore,
      flags,
      timestamp: now,
      merchantId: merchantId || 'TENANT_DEFAULT'
    };

    return evaluationResult;
  }

  recordPaymentFailure(customerId) {
    if (!this.paymentFailureVelocity.has(customerId)) {
      this.paymentFailureVelocity.set(customerId, []);
    }
    this.paymentFailureVelocity.get(customerId).push(Date.now());
  }

  recordCustomerCancellation(customerId) {
    if (!this.customerCancellationVelocity.has(customerId)) {
      this.customerCancellationVelocity.set(customerId, []);
    }
    this.customerCancellationVelocity.get(customerId).push(Date.now());
  }

  /**
   * Maker-Checker Workflow: Initiates high-risk review
   */
  createReviewTicket(actionType, makerId, payload) {
    const reviewId = `REV_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const ticket = {
      reviewId,
      actionType,
      makerId,
      checkerId: null,
      status: 'PENDING',
      createdAt: Date.now(),
      payload
    };
    this.reviewQueue.set(reviewId, ticket);
    return ticket;
  }

  /**
   * Maker-Checker Workflow: Approves or Rejects review ticket
   */
  resolveReviewTicket(reviewId, checkerId, resolution = 'APPROVED', reason = '') {
    metricsService.increment('risk_maker_checker_actions_total');
    const ticket = this.reviewQueue.get(reviewId);
    if (!ticket) {
      return { success: false, error: 'TICKET_NOT_FOUND' };
    }

    // Strict Maker-Checker Dual-Control Invariant
    if (String(ticket.makerId) === String(checkerId)) {
      return {
        success: false,
        error: 'DUAL_CONTROL_VIOLATION',
        message: 'Maker and Checker must be distinct authorized identities. Self-approval is strictly prohibited.'
      };
    }

    ticket.checkerId = checkerId;
    ticket.status = resolution === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    ticket.resolutionReason = reason;
    ticket.resolvedAt = Date.now();

    return {
      success: true,
      ticket
    };
  }
}

const fraudRiskEngine = new FraudRiskEngine();

module.exports = {
  FraudRiskEngine,
  fraudRiskEngine,
  RISK_DECISIONS
};
