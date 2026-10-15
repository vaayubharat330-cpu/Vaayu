'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { PostgresLedgerRepository } = require('./postgresLedgerRepository');

/**
 * The legacy repository builds response objects while its transaction is still open.
 * Those response paths call getCustomerBalance(), which otherwise acquires a second
 * PostgreSQL connection and waits on the row lock held by the first connection.
 * This subclass supplies the transaction-local projected balance for those calls.
 * Ledger mutations themselves remain owned by PostgresLedgerRepository.
 */
const balanceContext = new AsyncLocalStorage();

class SafePostgresLedgerRepository extends PostgresLedgerRepository {
  async getCustomerBalance(customerId) {
    const context = balanceContext.getStore();
    if (context && context.customerId === customerId && context.customerBalance) {
      return context.customerBalance;
    }
    return super.getCustomerBalance(customerId);
  }

  async reserveEscrow(args) {
    const current = await super.getCustomerBalance(args.customerId);
    const projected = Math.max(0, Number(current.paise) - Number(args.amountPaise));
    return balanceContext.run({
      customerId: args.customerId,
      customerBalance: { paise: projected, rupees: +(projected / 100).toFixed(2) }
    }, () => super.reserveEscrow(args));
  }

  async refundTrip(args) {
    const customerId = args.customerId || (args.tripId ? (await super.getPayment(args.paymentId || `PAY_${args.tripId}`))?.customerId : null);
    if (!customerId) return super.refundTrip(args);
    const current = await super.getCustomerBalance(customerId);
    const refundAmount = Number(args.amountPaise || 0);
    const projected = Number(current.paise) + Math.max(0, refundAmount);
    return balanceContext.run({
      customerId,
      customerBalance: { paise: projected, rupees: +(projected / 100).toFixed(2) }
    }, () => super.refundTrip(args));
  }

  async expirePayment(args) {
    const payment = await super.getPayment(args.paymentId || `PAY_${args.tripId}`);
    if (!payment) return super.expirePayment(args);
    const current = await super.getCustomerBalance(payment.customerId);
    const projected = Number(current.paise) + Number(payment.escrowPaise || 0);
    return balanceContext.run({
      customerId: payment.customerId,
      customerBalance: { paise: projected, rupees: +(projected / 100).toFixed(2) }
    }, () => super.expirePayment(args));
  }
}

module.exports = { SafePostgresLedgerRepository };
