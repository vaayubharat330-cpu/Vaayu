'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { PostgresLedgerRepository } = require('./postgresLedgerRepository');

const balanceContext = new AsyncLocalStorage();

/**
 * Prevents the legacy repository's response-time balance lookup from opening a
 * second connection against an account row still locked by the mutation transaction.
 */
class SafePostgresLedgerRepository extends PostgresLedgerRepository {
  async getCustomerBalance(customerId) {
    const context = balanceContext.getStore();
    if (context && context.customerId === customerId && context.customerBalance) return context.customerBalance;
    return super.getCustomerBalance(customerId);
  }

  async reserveEscrow(args) {
    const current = await super.getCustomerBalance(args.customerId);
    const projected = Math.max(0, Number(current.paise) - Number(args.amountPaise));
    return balanceContext.run({ customerId: args.customerId, customerBalance: { paise: projected, rupees: +(projected / 100).toFixed(2) } }, () => super.reserveEscrow(args));
  }

  async refundTrip(args) {
    const payment = await super.getPayment(args.paymentId || `PAY_${args.tripId}`);
    if (!payment) return super.refundTrip(args);
    const customerId = payment.customerId;
    const current = await super.getCustomerBalance(customerId);
    const refundAmount = args.amountPaise === null || args.amountPaise === undefined ? Number(payment.escrowPaise || 0) : Number(args.amountPaise);
    const projected = Number(current.paise) + Math.max(0, refundAmount);
    return balanceContext.run({ customerId, customerBalance: { paise: projected, rupees: +(projected / 100).toFixed(2) } }, () => super.refundTrip(args));
  }

  async expirePayment(args) {
    const payment = await super.getPayment(args.paymentId || `PAY_${args.tripId}`);
    if (!payment) return super.expirePayment(args);
    const current = await super.getCustomerBalance(payment.customerId);
    const projected = Number(current.paise) + Number(payment.escrowPaise || 0);
    return balanceContext.run({ customerId: payment.customerId, customerBalance: { paise: projected, rupees: +(projected / 100).toFixed(2) } }, () => super.expirePayment(args));
  }
}

module.exports = { SafePostgresLedgerRepository };
