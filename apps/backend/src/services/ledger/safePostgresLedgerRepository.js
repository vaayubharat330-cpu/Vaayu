'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const { PostgresLedgerRepository } = require('./postgresLedgerRepository');
const { LedgerError } = require('./ledgerService');

const balanceContext = new AsyncLocalStorage();

class SafePostgresLedgerRepository extends PostgresLedgerRepository {
  async getCustomerBalance(customerId) {
    const context = balanceContext.getStore();
    if (context && context.customerId === customerId && context.customerBalance) return context.customerBalance;
    return super.getCustomerBalance(customerId);
  }

  async reserveEscrow(args) {
    const current = await super.getCustomerBalance(args.customerId);
    const existing = await super.getPayment(`PAY_${args.tripId}`);
    const projected = existing?.state === 'ESCROWED' ? Number(current.paise) : Math.max(0, Number(current.paise) - Number(args.amountPaise));
    return balanceContext.run({ customerId: args.customerId, customerBalance: { paise: projected, rupees: +(projected / 100).toFixed(2) } }, () => super.reserveEscrow(args));
  }

  async refundTrip(args) {
    const payment = await super.getPayment(args.paymentId || `PAY_${args.tripId}`);
    if (!payment) return super.refundTrip(args);
    const current = await super.getCustomerBalance(payment.customerId);
    const refundAmount = args.amountPaise === null || args.amountPaise === undefined ? Number(payment.escrowPaise || 0) : Number(args.amountPaise);
    const projected = Number(current.paise) + Math.max(0, refundAmount);
    return balanceContext.run({ customerId: payment.customerId, customerBalance: { paise: projected, rupees: +(projected / 100).toFixed(2) } }, () => super.refundTrip(args));
  }

  async expirePayment(args) {
    const payment = await super.getPayment(args.paymentId || `PAY_${args.tripId}`);
    if (!payment) return super.expirePayment(args);
    const current = await super.getCustomerBalance(payment.customerId);
    const projected = Number(current.paise) + Number(payment.escrowPaise || 0);
    return balanceContext.run({ customerId: payment.customerId, customerBalance: { paise: projected, rupees: +(projected / 100).toFixed(2) } }, () => super.expirePayment(args));
  }

  async disputePayment({ tripId, paymentId = null, disputeId, reason = 'Customer complaint', idempotencyKey = null }) {
    const paymentIdResolved = paymentId || `PAY_${tripId}`;
    const key = idempotencyKey || `VAAYU:${tripId || paymentIdResolved}:DISPUTE:${disputeId}`;
    const client = await this.pool.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PAYMENT_${paymentIdResolved}`]);

      const idemp = await client.query('SELECT response_payload FROM ledger_idempotency WHERE idempotency_key = $1 FOR UPDATE', [key]);
      if (idemp.rows.length) { await client.query('COMMIT'); return { ...idemp.rows[0].response_payload, idempotentReplay: true }; }

      const txRes = await client.query('SELECT * FROM payment_transactions WHERE payment_id = $1 FOR UPDATE', [paymentIdResolved]);
      if (!txRes.rows.length) throw new LedgerError('PAYMENT_NOT_FOUND', `No payment transaction exists for ${paymentIdResolved}`);
      const tx = this._mapPayment(txRes.rows[0]);
      if (tx.state === 'DISPUTED') {
        if (tx.disputeId && tx.disputeId !== disputeId) throw new LedgerError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Payment is already disputed under a different dispute ID.');
        const response = { success: true, status: 'DISPUTED', tripId: tx.tripId, paymentId: tx.paymentId, disputeId: tx.disputeId || disputeId, idempotentReplay: true, version: tx.version };
        await client.query('COMMIT'); return response;
      }
      if (tx.state !== 'SETTLED') throw new LedgerError('ILLEGAL_PAYMENT_TRANSITION', `Illegal payment transition: ${tx.state} -> DISPUTED for payment ${paymentIdResolved}`, { currentState: tx.state, attemptedState: 'DISPUTED', paymentId: paymentIdResolved });

      const nextVersion = tx.version + 1;
      await client.query('UPDATE payment_transactions SET state = $1, dispute_id = $2, version = $3, updated_at = NOW() WHERE payment_id = $4 AND version = $5', ['DISPUTED', disputeId, nextVersion, paymentIdResolved, tx.version]);
      const eventId = `EVT_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 60)}`;
      await client.query(`INSERT INTO payment_outbox (event_id, aggregate_type, aggregate_id, event_type, payload, created_at, status) VALUES ($1,'PAYMENT',$2,'PaymentDisputed',$3,NOW(),'PENDING') ON CONFLICT (event_id) DO NOTHING`, [eventId, tx.paymentId, JSON.stringify({ tripId: tx.tripId, paymentId: tx.paymentId, disputeId, reason })]);
      const response = { success: true, status: 'DISPUTED', tripId: tx.tripId, paymentId: tx.paymentId, disputeId, idempotentReplay: false, version: nextVersion };
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({ tripId: tx.tripId, paymentId: tx.paymentId, disputeId, reason })).digest('hex');
      await client.query('INSERT INTO ledger_idempotency (idempotency_key, request_hash, entry_id, response_payload, created_at) VALUES ($1,$2,NULL,$3,NOW())', [key, requestHash, JSON.stringify(response)]);
      await client.query('COMMIT');
      return response;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async adjustPayment({ tripId, paymentId = null, disputeId, adjustmentPaise = null, allocations, reason = 'Dispute resolution', idempotencyKey = null }) {
    const paymentIdResolved = paymentId || `PAY_${tripId}`;
    const key = idempotencyKey || `VAAYU:${tripId || paymentIdResolved}:ADJUST:${disputeId}`;
    const customerCredit = Number(allocations?.customerCreditPaise || 0);
    const driverDebit = Number(allocations?.driverDebitPaise || 0);
    const platformDebit = Number(allocations?.platformDebitPaise || 0);
    const taxAdjustment = Number(allocations?.taxAdjustmentPaise || 0);
    if ([customerCredit, driverDebit, platformDebit, taxAdjustment].some(v => !Number.isSafeInteger(v) || v < 0)) throw new LedgerError('INVALID_ADJUSTMENT_ALLOCATION', 'Adjustment allocations must be non-negative integer paise amounts.');
    if (customerCredit !== driverDebit + platformDebit + taxAdjustment) throw new LedgerError('INVALID_ADJUSTMENT_ALLOCATION', 'Adjustment debits must equal customer credit.');
    if (adjustmentPaise !== null && adjustmentPaise !== undefined && Number(adjustmentPaise) !== customerCredit) throw new LedgerError('INVALID_ADJUSTMENT_ALLOCATION', 'adjustmentPaise must equal customerCreditPaise.');

    const client = await this.pool.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PAYMENT_${paymentIdResolved}`]);
      const idemp = await client.query('SELECT response_payload FROM ledger_idempotency WHERE idempotency_key = $1 FOR UPDATE', [key]);
      if (idemp.rows.length) { await client.query('COMMIT'); return { ...idemp.rows[0].response_payload, idempotentReplay: true }; }
      const txRes = await client.query('SELECT * FROM payment_transactions WHERE payment_id = $1 FOR UPDATE', [paymentIdResolved]);
      if (!txRes.rows.length) throw new LedgerError('PAYMENT_NOT_FOUND', `No payment transaction exists for ${paymentIdResolved}`);
      const tx = this._mapPayment(txRes.rows[0]);
      if (tx.state !== 'DISPUTED') {
        if (tx.state === 'ADJUSTED') throw new LedgerError('DISPUTE_ALREADY_ADJUSTED', `Payment ${paymentIdResolved} has already been adjusted.`);
        throw new LedgerError('ILLEGAL_PAYMENT_TRANSITION', `Illegal payment transition: ${tx.state} -> ADJUSTED for payment ${paymentIdResolved}`, { currentState: tx.state, attemptedState: 'ADJUSTED', paymentId: paymentIdResolved });
      }
      if (customerCredit > tx.amountPaise) throw new LedgerError('ADJUSTMENT_EXCEEDS_FARE', 'Customer adjustment exceeds original fare.');
      if (driverDebit > Number(tx.driverEarningsPaise || 0)) throw new LedgerError('ADJUSTMENT_EXCEEDS_EARNINGS', 'Driver debit exceeds recorded driver earnings.');

      const postings = [{ accountId: this.getCustomerAccountId(tx.customerId), side: 'CREDIT', amountPaise: customerCredit }];
      if (driverDebit) postings.push({ accountId: this.getDriverAccountId(tx.driverId), side: 'DEBIT', amountPaise: driverDebit });
      if (platformDebit) postings.push({ accountId: 'platform:commission', side: 'DEBIT', amountPaise: platformDebit });
      if (taxAdjustment) postings.push({ accountId: 'platform:gst', side: 'DEBIT', amountPaise: taxAdjustment });

      const paymentRecord = { ...tx, adjustmentPaise: customerCredit, state: 'ADJUSTED', version: tx.version + 1 };
      const eventId = `EVT_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 60)}`;
      const ledgerResult = await this._executePostingsWithinClient(client, {
        referenceId: `TRIP_${tx.tripId}_ADJUST`, idempotencyKey: key, description: `Dispute adjustment for trip ${tx.tripId}: ${reason}`,
        postings, metadata: { tripId: tx.tripId, paymentId: tx.paymentId, disputeId, type: 'TRIP_ADJUSTMENT' }, paymentRecord,
        outboxEvent: { eventId, aggregateType: 'PAYMENT', aggregateId: tx.paymentId, eventType: 'PaymentAdjusted', payload: { tripId: tx.tripId, paymentId: tx.paymentId, disputeId, adjustmentPaise: customerCredit, allocations, reason } }
      });
      const response = { success: true, status: 'ADJUSTED', tripId: tx.tripId, paymentId: tx.paymentId, disputeId, transactionId: ledgerResult.entryId, idempotentReplay: false, adjustmentPaise: customerCredit, allocations, version: paymentRecord.version };
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({ tripId: tx.tripId, paymentId: tx.paymentId, disputeId, adjustmentPaise: customerCredit, allocations, reason })).digest('hex');
      await client.query('INSERT INTO ledger_idempotency (idempotency_key, request_hash, entry_id, response_payload, created_at) VALUES ($1,$2,$3,$4,NOW())', [key, requestHash, ledgerResult.entryId, JSON.stringify(response)]);
      await client.query('COMMIT');
      return response;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}

module.exports = { SafePostgresLedgerRepository };
