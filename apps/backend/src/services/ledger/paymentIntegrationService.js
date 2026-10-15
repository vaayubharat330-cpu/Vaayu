'use strict';

const { PaymentStateMachine } = require('./paymentStateMachine');
const { PostgresLedgerRepository } = require('./postgresLedgerRepository');

const ERROR_CODES = Object.freeze({
  INSUFFICIENT_WALLET_BALANCE: 'INSUFFICIENT_WALLET_BALANCE', PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND', TRIP_PAYMENT_MISMATCH: 'TRIP_PAYMENT_MISMATCH', ORDER_PAYMENT_MISMATCH: 'ORDER_PAYMENT_MISMATCH', ILLEGAL_STATE_TRANSITION: 'ILLEGAL_STATE_TRANSITION', PAYMENT_ALREADY_SETTLED: 'PAYMENT_ALREADY_SETTLED', PAYMENT_EXPIRED: 'PAYMENT_EXPIRED', REFUND_LIMIT_EXCEEDED: 'REFUND_LIMIT_EXCEEDED', DUPLICATE_IDEMPOTENCY_KEY: 'DUPLICATE_IDEMPOTENCY_KEY', IDEMPOTENCY_PAYLOAD_MISMATCH: 'IDEMPOTENCY_PAYLOAD_MISMATCH', PAYMENT_VERSION_CONFLICT: 'PAYMENT_VERSION_CONFLICT', DISPUTE_ALREADY_ADJUSTED: 'DISPUTE_ALREADY_ADJUSTED', INVALID_ADJUSTMENT_ALLOCATION: 'INVALID_ADJUSTMENT_ALLOCATION', ADJUSTMENT_EXCEEDS_EARNINGS: 'ADJUSTMENT_EXCEEDS_EARNINGS', ADJUSTMENT_EXCEEDS_FARE: 'ADJUSTMENT_EXCEEDS_FARE', INVALID_PARAMS: 'INVALID_PARAMS'
});

function normalizeErrorCode(rawCode) {
  switch (rawCode) {
    case 'INSUFFICIENT_FUNDS': return ERROR_CODES.INSUFFICIENT_WALLET_BALANCE;
    case 'ILLEGAL_PAYMENT_TRANSITION': case 'PAYMENT_STATE_CONFLICT': return ERROR_CODES.ILLEGAL_STATE_TRANSITION;
    case 'VERSION_CONFLICT': return ERROR_CODES.PAYMENT_VERSION_CONFLICT;
    case 'IDEMPOTENCY_CONFLICT': return ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH;
    default: return ERROR_CODES[rawCode] || rawCode || 'INTERNAL_ERROR';
  }
}

class PaymentIntegrationService {
  constructor({ paymentStateMachine, ledgerService, commissionConfig } = {}) {
    // Keep the PSM local for synchronous reporting APIs, but route financial mutations and
    // authoritative status reads through the durable ledger when one is supplied.
    this.durableLedger = ledgerService || null;
    this.psm = paymentStateMachine || new PaymentStateMachine({ commissionConfig });
    this.events = [];
    this.psm.on('*', (event) => this.events.push(event));
  }

  _ledger() {
    return this.durableLedger || this.psm?.ledger || null;
  }

  _formatError(err, context = {}) {
    const code = normalizeErrorCode(err.code);
    return { success: false, error: { code, message: err.message, paymentId: context.paymentId || err.details?.paymentId || (context.tripId ? `PAY_${context.tripId}` : null), currentState: err.details?.currentState || err.details?.actualState || null, details: err.details || null } };
  }

  async reserveEscrow({ tripId, orderId = null, customerId, amountPaise, idempotencyKey = null }) {
    if (!tripId || !customerId || !amountPaise) return this._formatError(new Error('tripId, customerId, and amountPaise are required.'), { tripId });
    const key = idempotencyKey || `VAAYU:${tripId}:ESCROW`;
    try {
      const ledger = this._ledger();
      if (ledger?.reserveEscrow) { const r = await ledger.reserveEscrow({ tripId, orderId: orderId || tripId, customerId, amountPaise, idempotencyKey: key }); return { success: true, paymentId: r.paymentId, tripId: r.tripId, state: r.status, escrowPaise: r.escrowPaise, idempotentReplay: r.idempotentReplay, version: r.version }; }
      const r = await this.psm.reserveEscrow({ tripId, orderId: orderId || tripId, customerId, amountPaise, idempotencyKey: key });
      return { success: true, paymentId: r.paymentId, tripId: r.tripId, state: r.status, escrowPaise: r.amountPaise, idempotentReplay: r.idempotentReplay, version: r.version };
    } catch (err) { return this._formatError(err, { tripId }); }
  }

  async settleTrip({ tripId, driverId, amountPaise = null, platformCommissionPaise = null, idempotencyKey = null }) {
    if (!tripId || !driverId) return this._formatError(new Error('tripId and driverId are required.'), { tripId });
    const key = idempotencyKey || `VAAYU:${tripId}:SETTLEMENT`;
    try {
      const ledger = this._ledger();
      if (ledger?.settleTrip) { const r = await ledger.settleTrip({ tripId, driverId, amountPaise, platformCommissionPaise, idempotencyKey: key }); return { success: true, paymentId: r.paymentId, tripId: r.tripId, state: r.status, totalFarePaise: r.totalFarePaise, driverEarningsPaise: r.driverEarningsPaise, commissionPaise: r.commissionPaise, gstPaise: r.gstPaise, idempotentReplay: r.idempotentReplay, version: r.version }; }
      const r = await this.psm.settleTrip({ tripId, driverId, amountPaise, platformCommissionPaise, idempotencyKey: key });
      return { success: true, paymentId: r.paymentId, tripId: r.tripId, state: r.status, totalFarePaise: r.totalFarePaise, driverEarningsPaise: r.driverEarningsPaise, commissionPaise: r.commissionPaise, gstPaise: r.gstPaise, idempotentReplay: r.idempotentReplay, version: r.version };
    } catch (err) { return this._formatError(err, { tripId }); }
  }

  async refundTrip({ tripId, paymentId = null, amountPaise = null, reason = 'Trip cancelled', idempotencyKey = null }) {
    if (!tripId && !paymentId) return this._formatError(new Error('tripId or paymentId is required.'), { tripId, paymentId });
    try {
      const ledger = this._ledger();
      if (ledger?.refundTrip) { const r = await ledger.refundTrip({ tripId, paymentId, amountPaise, reason, idempotencyKey }); return { success: true, paymentId: r.paymentId, tripId: r.tripId, state: r.status, isPartial: r.isPartial, refundedPaise: r.refundedPaise, totalRefundedPaise: r.refundedPaise, remainingEscrowPaise: r.remainingEscrowPaise, idempotentReplay: r.idempotentReplay, version: r.version }; }
      const r = await this.psm.refundTrip({ tripId, paymentId, amountPaise, reason, idempotencyKey });
      return { success: true, paymentId: r.paymentId, tripId: r.tripId, state: r.status, isPartial: r.isPartial, refundedPaise: r.refundedPaise, totalRefundedPaise: r.totalRefundedPaise, remainingEscrowPaise: r.remainingEscrowPaise, idempotentReplay: r.idempotentReplay, version: r.version };
    } catch (err) { return this._formatError(err, { tripId, paymentId }); }
  }

  async expirePayment({ tripId, paymentId = null, reason = 'Dispatch search timed out', idempotencyKey = null }) {
    if (!tripId && !paymentId) return this._formatError(new Error('tripId or paymentId is required.'), { tripId, paymentId });
    const key = idempotencyKey || `VAAYU:${tripId || paymentId}:EXPIRY`;
    try {
      const ledger = this._ledger();
      if (ledger?.expirePayment) { const r = await ledger.expirePayment({ tripId, paymentId, reason, idempotencyKey: key }); return { success: true, paymentId: r.paymentId, tripId: r.tripId, state: r.status, releasedPaise: r.releasedPaise, idempotentReplay: r.idempotentReplay, version: r.version }; }
      const r = await this.psm.expirePayment({ tripId, paymentId, reason, idempotencyKey: key });
      return { success: true, paymentId: r.paymentId, tripId: r.tripId, state: r.status, releasedPaise: r.releasedPaise, idempotentReplay: r.idempotentReplay, version: r.version };
    } catch (err) { return this._formatError(err, { tripId, paymentId }); }
  }

  async disputePayment({ tripId, paymentId = null, disputeId, reason = 'Customer complaint', idempotencyKey = null }) {
    if (!disputeId) return this._formatError(new Error('disputeId is required.'), { tripId, paymentId });
    try {
      const ledger = this._ledger();
      if (ledger?.disputePayment) { const r = await ledger.disputePayment({ tripId, paymentId, disputeId, reason, idempotencyKey }); return { success: true, paymentId: r.paymentId, tripId: r.tripId, disputeId: r.disputeId, state: r.status, idempotentReplay: r.idempotentReplay, version: r.version }; }
      const r = await this.psm.disputePayment({ tripId, paymentId, disputeId, reason, idempotencyKey });
      return { success: true, paymentId: r.paymentId, tripId: r.tripId, disputeId: r.disputeId, state: r.status, idempotentReplay: r.idempotentReplay, version: r.version };
    } catch (err) { return this._formatError(err, { tripId, paymentId }); }
  }

  async adjustPayment({ tripId, paymentId = null, disputeId, adjustmentPaise, allocations, reason = 'Dispute resolution', idempotencyKey = null }) {
    if (!disputeId || !allocations) return this._formatError(new Error('disputeId and allocations are required.'), { tripId, paymentId });
    try {
      const ledger = this._ledger();
      if (ledger?.adjustPayment) { const r = await ledger.adjustPayment({ tripId, paymentId, disputeId, adjustmentPaise, allocations, reason, idempotencyKey }); return { success: true, paymentId: r.paymentId, tripId: r.tripId, disputeId: r.disputeId, state: r.status, adjustmentPaise: r.adjustmentPaise, allocations: r.allocations, idempotentReplay: r.idempotentReplay, version: r.version }; }
      const r = await this.psm.adjustPayment({ tripId, paymentId, disputeId, adjustmentPaise, allocations, reason, idempotencyKey });
      return { success: true, paymentId: r.paymentId, tripId: r.tripId, disputeId: r.disputeId, state: r.status, adjustmentPaise: r.adjustmentPaise, allocations: r.allocations, idempotentReplay: r.idempotentReplay, version: r.version };
    } catch (err) { return this._formatError(err, { tripId, paymentId }); }
  }

  async getPaymentStatus(tripId) {
    try {
      const ledger = this._ledger();
      if (ledger?.getPaymentByTripId) { const tx = await ledger.getPaymentByTripId(tripId); if (!tx) return { success: false, error: { code: ERROR_CODES.PAYMENT_NOT_FOUND, message: `No payment transaction found for trip ${tripId}` } }; return { success: true, payment: tx, source: 'durable-ledger' }; }
      const tx = this.psm.getPaymentByTripId(tripId); if (!tx) return { success: false, error: { code: ERROR_CODES.PAYMENT_NOT_FOUND, message: `No payment transaction found for trip ${tripId}` } }; return { success: true, payment: tx, source: 'local-psm' };
    } catch (err) { return this._formatError(err, { tripId }); }
  }

  getReconciliation() { try { return { success: true, reconciliation: this.psm.reconcileDetailed() }; } catch (err) { return this._formatError(err); } }
  getLedgerAudit() { try { return { success: true, audit: this.psm.getLedgerAudit() }; } catch (err) { return this._formatError(err); } }
  queryTransactions(filters = {}) { try { return { success: true, ...this.psm.queryTransactions(filters) }; } catch (err) { return this._formatError(err); } }
  getFinancialStats() { try { return { success: true, stats: this.psm.getFinancialStats() }; } catch (err) { return this._formatError(err); } }
}

function createDefaultPaymentIntegrationService() {
  const usePostgres = ['postgres', 'postgresql'].includes(String(process.env.PERSISTENCE_PROVIDER || '').toLowerCase()) && Boolean(process.env.DATABASE_URL);
  if (!usePostgres) return new PaymentIntegrationService();
  return new PaymentIntegrationService({ ledgerService: new PostgresLedgerRepository(process.env.DATABASE_URL) });
}

const defaultPaymentIntegrationService = createDefaultPaymentIntegrationService();
module.exports = { PaymentIntegrationService, paymentIntegrationService: defaultPaymentIntegrationService, ERROR_CODES };