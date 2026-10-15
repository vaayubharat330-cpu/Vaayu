'use strict';

const { PaymentStateMachine, PaymentStateError } = require('./paymentStateMachine');
const { LedgerError } = require('./ledgerService');

/**
 * Standardized Machine-Readable Error Codes
 */
const ERROR_CODES = Object.freeze({
  INSUFFICIENT_WALLET_BALANCE: 'INSUFFICIENT_WALLET_BALANCE',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  TRIP_PAYMENT_MISMATCH: 'TRIP_PAYMENT_MISMATCH',
  ORDER_PAYMENT_MISMATCH: 'ORDER_PAYMENT_MISMATCH',
  ILLEGAL_STATE_TRANSITION: 'ILLEGAL_STATE_TRANSITION',
  PAYMENT_ALREADY_SETTLED: 'PAYMENT_ALREADY_SETTLED',
  PAYMENT_EXPIRED: 'PAYMENT_EXPIRED',
  REFUND_LIMIT_EXCEEDED: 'REFUND_LIMIT_EXCEEDED',
  DUPLICATE_IDEMPOTENCY_KEY: 'DUPLICATE_IDEMPOTENCY_KEY',
  IDEMPOTENCY_PAYLOAD_MISMATCH: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  PAYMENT_VERSION_CONFLICT: 'PAYMENT_VERSION_CONFLICT',
  DISPUTE_ALREADY_ADJUSTED: 'DISPUTE_ALREADY_ADJUSTED',
  INVALID_ADJUSTMENT_ALLOCATION: 'INVALID_ADJUSTMENT_ALLOCATION',
  ADJUSTMENT_EXCEEDS_EARNINGS: 'ADJUSTMENT_EXCEEDS_EARNINGS',
  ADJUSTMENT_EXCEEDS_FARE: 'ADJUSTMENT_EXCEEDS_FARE',
  INVALID_PARAMS: 'INVALID_PARAMS'
});

/**
 * Map internal error codes to public integration error codes
 */
function normalizeErrorCode(rawCode) {
  switch (rawCode) {
    case 'INSUFFICIENT_FUNDS':
      return ERROR_CODES.INSUFFICIENT_WALLET_BALANCE;
    case 'ILLEGAL_PAYMENT_TRANSITION':
    case 'PAYMENT_STATE_CONFLICT':
      return ERROR_CODES.ILLEGAL_STATE_TRANSITION;
    case 'VERSION_CONFLICT':
      return ERROR_CODES.PAYMENT_VERSION_CONFLICT;
    case 'IDEMPOTENCY_CONFLICT':
      return ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH;
    default:
      return ERROR_CODES[rawCode] || rawCode || 'INTERNAL_ERROR';
  }
}

/**
 * VAAYU PAYMENT INTEGRATION SERVICE
 * 
 * Serves as the clean domain gateway between the VAAYU Trip/Order Dispatch Engine
 * and the Double-Entry Payment State Machine (PSM).
 * 
 * Responsibilities:
 * 1. Validates trip and order contextual boundaries.
 * 2. Enforces deterministic idempotency keys across actions.
 * 3. Normalizes errors into standard machine-readable JSON envelopes.
 * 4. Subscribes to PSM domain events for outward distribution.
 */
class PaymentIntegrationService {
  constructor({ paymentStateMachine, ledgerService, commissionConfig } = {}) {
    this.psm = paymentStateMachine || new PaymentStateMachine({ ledgerService, commissionConfig });
    this.events = [];

    // Subscribe to domain events
    this.psm.on('*', (event) => {
      this.events.push(event);
    });
  }

  /**
   * Helper to format standardized failure responses
   */
  _formatError(err, context = {}) {
    const code = normalizeErrorCode(err.code);
    return {
      success: false,
      error: {
        code,
        message: err.message,
        paymentId: context.paymentId || err.details?.paymentId || (context.tripId ? `PAY_${context.tripId}` : null),
        currentState: err.details?.currentState || err.details?.actualState || null,
        details: err.details || null
      }
    };
  }

  /**
   * 1. Reserve trip escrow hold
   */
  async reserveEscrow({ tripId, orderId = null, customerId, amountPaise, idempotencyKey = null }) {
    if (!tripId || !customerId || !amountPaise) {
      return this._formatError(new Error('tripId, customerId, and amountPaise are required.'), { tripId });
    }

    const key = idempotencyKey || `VAAYU:${tripId}:ESCROW`;
    try {
      // If backed by PostgresLedgerRepository, execute full persistent lifecycle
      if (this.psm?.ledger && typeof this.psm.ledger.reserveEscrow === 'function') {
        const result = await this.psm.ledger.reserveEscrow({
          tripId,
          orderId: orderId || tripId,
          customerId,
          amountPaise,
          idempotencyKey: key
        });
        return {
          success: true,
          paymentId: result.paymentId,
          tripId: result.tripId,
          state: result.status,
          escrowPaise: result.escrowPaise,
          idempotentReplay: result.idempotentReplay,
          version: result.version
        };
      }

      const result = await this.psm.reserveEscrow({
        tripId,
        orderId: orderId || tripId,
        customerId,
        amountPaise,
        idempotencyKey: key
      });
      return {
        success: true,
        paymentId: result.paymentId,
        tripId: result.tripId,
        state: result.status,
        escrowPaise: result.amountPaise,
        idempotentReplay: result.idempotentReplay,
        version: result.version
      };
    } catch (err) {
      return this._formatError(err, { tripId });
    }
  }

  /**
   * 2. Settle trip to driver with basis-point commission and statutory GST split
   */
  async settleTrip({ tripId, driverId, amountPaise = null, platformCommissionPaise = null, idempotencyKey = null }) {
    if (!tripId || !driverId) {
      return this._formatError(new Error('tripId and driverId are required.'), { tripId });
    }

    const key = idempotencyKey || `VAAYU:${tripId}:SETTLEMENT`;
    try {
      if (this.psm?.ledger && typeof this.psm.ledger.settleTrip === 'function') {
        const result = await this.psm.ledger.settleTrip({
          tripId,
          driverId,
          amountPaise,
          platformCommissionPaise,
          idempotencyKey: key
        });
        return {
          success: true,
          paymentId: result.paymentId,
          tripId: result.tripId,
          state: result.status,
          totalFarePaise: result.totalFarePaise,
          driverEarningsPaise: result.driverEarningsPaise,
          commissionPaise: result.commissionPaise,
          gstPaise: result.gstPaise,
          idempotentReplay: result.idempotentReplay,
          version: result.version
        };
      }

      const result = await this.psm.settleTrip({
        tripId,
        driverId,
        amountPaise,
        platformCommissionPaise,
        idempotencyKey: key
      });
      return {
        success: true,
        paymentId: result.paymentId,
        tripId: result.tripId,
        state: result.status,
        totalFarePaise: result.totalFarePaise,
        driverEarningsPaise: result.driverEarningsPaise,
        commissionPaise: result.commissionPaise,
        gstPaise: result.gstPaise,
        idempotentReplay: result.idempotentReplay,
        version: result.version
      };
    } catch (err) {
      return this._formatError(err, { tripId });
    }
  }

  /**
   * 3. Refund or partial fare adjustment
   */
  async refundTrip({ tripId, paymentId = null, amountPaise = null, reason = 'Trip cancelled', idempotencyKey = null }) {
    if (!tripId && !paymentId) {
      return this._formatError(new Error('tripId or paymentId is required.'), { tripId, paymentId });
    }

    try {
      if (this.psm?.ledger && typeof this.psm.ledger.refundTrip === 'function') {
        const result = await this.psm.ledger.refundTrip({
          tripId,
          paymentId,
          amountPaise,
          reason,
          idempotencyKey
        });
        return {
          success: true,
          paymentId: result.paymentId,
          tripId: result.tripId,
          state: result.status,
          isPartial: result.isPartial,
          refundedPaise: result.refundedPaise,
          totalRefundedPaise: result.refundedPaise,
          remainingEscrowPaise: result.remainingEscrowPaise,
          idempotentReplay: result.idempotentReplay,
          version: result.version
        };
      }

      const result = await this.psm.refundTrip({
        tripId,
        paymentId,
        amountPaise,
        reason,
        idempotencyKey
      });
      return {
        success: true,
        paymentId: result.paymentId,
        tripId: result.tripId,
        state: result.status,
        isPartial: result.isPartial,
        refundedPaise: result.refundedPaise,
        totalRefundedPaise: result.totalRefundedPaise,
        remainingEscrowPaise: result.remainingEscrowPaise,
        idempotentReplay: result.idempotentReplay,
        version: result.version
      };
    } catch (err) {
      return this._formatError(err, { tripId, paymentId });
    }
  }

  /**
   * 4. Expire abandoned escrow
   */
  async expirePayment({ tripId, paymentId = null, reason = 'Dispatch search timed out', idempotencyKey = null }) {
    if (!tripId && !paymentId) {
      return this._formatError(new Error('tripId or paymentId is required.'), { tripId, paymentId });
    }

    const key = idempotencyKey || `VAAYU:${tripId || paymentId}:EXPIRY`;
    try {
      const result = await this.psm.expirePayment({
        tripId,
        paymentId,
        reason,
        idempotencyKey: key
      });
      return {
        success: true,
        paymentId: result.paymentId,
        tripId: result.tripId,
        state: result.status,
        releasedPaise: result.releasedPaise,
        idempotentReplay: result.idempotentReplay,
        version: result.version
      };
    } catch (err) {
      return this._formatError(err, { tripId, paymentId });
    }
  }

  /**
   * 5. Initiate dispute on settled payment
   */
  async disputePayment({ tripId, paymentId = null, disputeId, reason = 'Customer complaint', idempotencyKey = null }) {
    if (!disputeId) {
      return this._formatError(new Error('disputeId is required.'), { tripId, paymentId });
    }

    try {
      const result = await this.psm.disputePayment({
        tripId,
        paymentId,
        disputeId,
        reason,
        idempotencyKey
      });
      return {
        success: true,
        paymentId: result.paymentId,
        tripId: result.tripId,
        disputeId: result.disputeId,
        state: result.status,
        idempotentReplay: result.idempotentReplay,
        version: result.version
      };
    } catch (err) {
      return this._formatError(err, { tripId, paymentId });
    }
  }

  /**
   * 6. Adjust disputed payment
   */
  async adjustPayment({ tripId, paymentId = null, disputeId, adjustmentPaise, allocations, reason = 'Dispute resolution', idempotencyKey = null }) {
    if (!disputeId || !allocations) {
      return this._formatError(new Error('disputeId and allocations are required.'), { tripId, paymentId });
    }

    try {
      const result = await this.psm.adjustPayment({
        tripId,
        paymentId,
        disputeId,
        adjustmentPaise,
        allocations,
        reason,
        idempotencyKey
      });
      return {
        success: true,
        paymentId: result.paymentId,
        tripId: result.tripId,
        disputeId: result.disputeId,
        state: result.status,
        adjustmentPaise: result.adjustmentPaise,
        allocations: result.allocations,
        idempotentReplay: result.idempotentReplay,
        version: result.version
      };
    } catch (err) {
      return this._formatError(err, { tripId, paymentId });
    }
  }

  /**
   * 7. Query payment status
   */
  getPaymentStatus(tripId) {
    const tx = this.psm.getPaymentByTripId(tripId);
    if (!tx) {
      return {
        success: false,
        error: {
          code: ERROR_CODES.PAYMENT_NOT_FOUND,
          message: `No payment transaction found for trip ${tripId}`
        }
      };
    }
    return {
      success: true,
      payment: tx
    };
  }

  /**
   * 8. Admin System-Wide Reconciliation
   */
  getReconciliation() {
    try {
      const reconciliation = this.psm.reconcileDetailed();
      return {
        success: true,
        reconciliation
      };
    } catch (err) {
      return this._formatError(err);
    }
  }

  /**
   * 9. Admin Comprehensive Ledger Health & Balances Audit
   */
  getLedgerAudit() {
    try {
      const audit = this.psm.getLedgerAudit();
      return {
        success: true,
        audit
      };
    } catch (err) {
      return this._formatError(err);
    }
  }

  /**
   * 10. Admin Query Transactions with Filtering & Pagination
   */
  queryTransactions(filters = {}) {
    try {
      const result = this.psm.queryTransactions(filters);
      return {
        success: true,
        ...result
      };
    } catch (err) {
      return this._formatError(err);
    }
  }

  /**
   * 11. Admin Financial Stats & GMV Overview
   */
  getFinancialStats() {
    try {
      const stats = this.psm.getFinancialStats();
      return {
        success: true,
        stats
      };
    } catch (err) {
      return this._formatError(err);
    }
  }
}

const defaultPaymentIntegrationService = new PaymentIntegrationService();

module.exports = {
  PaymentIntegrationService,
  paymentIntegrationService: defaultPaymentIntegrationService,
  ERROR_CODES
};
