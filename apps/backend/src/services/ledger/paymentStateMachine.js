'use strict';

const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { LedgerService, JsonLedgerRepository, LedgerError, ACCOUNT_TYPES } = require('./ledgerService');

/**
 * Custom Error for Payment State Machine transitions & concurrency
 */
class PaymentStateError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'PaymentStateError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Strict Payment State Transitions Matrix
 */
const PAYMENT_TRANSITIONS = Object.freeze({
  INITIATED: ['ESCROWED'],
  ESCROWED: ['SETTLED', 'REFUNDED', 'EXPIRED'],
  SETTLED: ['DISPUTED'],
  DISPUTED: ['ADJUSTED'],
  REFUNDED: [],
  EXPIRED: [],
  ADJUSTED: []
});

/**
 * Default Commission Configuration (Basis Points: 10000 bps = 100%)
 */
const DEFAULT_COMMISSION_CONFIG = Object.freeze({
  commissionBps: 1000, // 10.00% platform commission
  gstBps: 1800         // 18.00% GST on commission
});

/**
 * VAAYU PAYMENT STATE MACHINE (Step 1 + Step 2 + Step 3/4 Hardened)
 * 
 * Features:
 * 1. Persistent PaymentTransaction model bound to real tripId & orderId
 * 2. Strict transition matrix with illegal transition rejection
 * 3. Optimistic concurrency control using monotonic versioning
 * 4. Explicit basis-point commission & GST splitting with historical snapshots
 * 5. Pre-settlement partial refunds & fare adjustments with invariant validation
 * 6. Escrow expiration with automatic funds release
 * 7. Post-settlement disputes and strict allocation-verified compensatory adjustments
 * 8. Domain events (PaymentEscrowed, PaymentPartiallyRefunded, PaymentExpired, PaymentSettled, etc.)
 * 9. Deterministic idempotency keys: VAAYU:{tripId}:{ACTION}
 * 10. Isolated from frozen DeliveryStateMachine; communicates via explicit domain commands
 */
class PaymentStateMachine extends EventEmitter {
  constructor({ ledgerService, repositoryPath, commissionConfig = {} } = {}) {
    super();
    if (ledgerService) {
      this.ledger = ledgerService;
    } else {
      const defaultPath = repositoryPath || path.join(__dirname, '../../db/data/ledger_simulation.json');
      const repo = new JsonLedgerRepository(defaultPath);
      this.ledger = new LedgerService({ repository: repo });
    }

    this.commissionConfig = {
      commissionBps: commissionConfig.commissionBps ?? DEFAULT_COMMISSION_CONFIG.commissionBps,
      gstBps: commissionConfig.gstBps ?? DEFAULT_COMMISSION_CONFIG.gstBps
    };

    this.transactions = new Map(); // paymentId -> PaymentTransaction
    this.tripToPaymentMap = new Map(); // tripId -> paymentId
    this.paymentQueues = new Map(); // paymentId -> Promise
    this._ensureSystemAccounts();
  }

  async _withPaymentLock(paymentId, fn) {
    const prev = this.paymentQueues.get(paymentId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.paymentQueues.set(paymentId, prev.then(() => current));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.paymentQueues.get(paymentId) === current) {
        this.paymentQueues.delete(paymentId);
      }
    }
  }

  _ensureSystemAccounts() {
    this.ledger.ensureAccount('cash:external', ACCOUNT_TYPES.ASSET);
    this.ledger.ensureAccount('escrow:platform', ACCOUNT_TYPES.LIABILITY);
    this.ledger.ensureAccount('platform:commission', ACCOUNT_TYPES.REVENUE);
    this.ledger.ensureAccount('platform:gst', ACCOUNT_TYPES.LIABILITY); // Taxes payable to tax authority
    this.ledger.ensureAccount('payout:clearing', ACCOUNT_TYPES.LIABILITY);
  }

  _emitDomainEvent(eventType, payload = {}) {
    const event = {
      eventType,
      eventId: `EVT_${crypto.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random().toString(36).substring(2, 8)}`,
      occurredAt: new Date().toISOString(),
      ...payload
    };
    this.emit(eventType, event);
    this.emit('*', event);
    return event;
  }

  getCustomerAccountId(customerId) {
    return `customer:${customerId}:wallet`;
  }

  getDriverAccountId(driverId) {
    return `driver:${driverId}:earnings`;
  }

  getCustomerBalance(customerId) {
    const accountId = this.getCustomerAccountId(customerId);
    try {
      const acc = this.ledger.getAccount(accountId);
      return { paise: acc.balancePaise, rupees: +(acc.balancePaise / 100).toFixed(2) };
    } catch (_) {
      return { paise: 0, rupees: 0 };
    }
  }

  getDriverBalance(driverId) {
    const accountId = this.getDriverAccountId(driverId);
    try {
      const acc = this.ledger.getAccount(accountId);
      return { paise: acc.balancePaise, rupees: +(acc.balancePaise / 100).toFixed(2) };
    } catch (_) {
      return { paise: 0, rupees: 0 };
    }
  }

  getBalance(accountId) {
    try {
      return this.ledger.getAccount(accountId).balancePaise;
    } catch (_) {
      return 0;
    }
  }

  getPayment(paymentId) {
    const tx = this.transactions.get(paymentId);
    if (tx) return JSON.parse(JSON.stringify(tx));

    // Fallback: recover transaction from persistent ledger entries
    return this._recoverPaymentFromLedger(paymentId);
  }

  getPaymentByTripId(tripId) {
    const paymentId = this.tripToPaymentMap.get(tripId) || `PAY_${tripId}`;
    return this.getPayment(paymentId);
  }

  _recoverPaymentFromLedger(paymentId) {
    try {
      const state = this.ledger.repository.snapshot();
      const relevantEntries = (state.journalEntries || []).filter(e => 
        e.metadata?.paymentId === paymentId || e.referenceId?.includes(paymentId.replace('PAY_', ''))
      );

      if (relevantEntries.length === 0) return null;

      // Reconstruct transaction state
      const tripId = paymentId.replace('PAY_', '');
      let latestState = 'INITIATED';
      let escrowPaise = 0;
      let driverId = null;
      let driverEarningsPaise = 0;
      let commissionPaise = 0;
      let gstPaise = 0;
      let lastEntryId = null;
      let totalAmountPaise = 0;
      let customerId = null;

      for (const entry of relevantEntries) {
        lastEntryId = entry.entryId;
        if (entry.metadata?.customerId) customerId = entry.metadata.customerId;
        if (entry.metadata?.totalPaise) totalAmountPaise = entry.metadata.totalPaise;

        if (entry.metadata?.type === 'TRIP_ESCROW') {
          latestState = 'ESCROWED';
          escrowPaise = entry.totalPaise;
          totalAmountPaise = entry.totalPaise;
        } else if (entry.metadata?.type === 'TRIP_SETTLEMENT') {
          latestState = 'SETTLED';
          escrowPaise = 0;
          driverId = entry.metadata.driverId;
          driverEarningsPaise = entry.metadata.driverEarningsPaise;
          commissionPaise = entry.metadata.commissionPaise;
          gstPaise = entry.metadata.gstPaise;
        } else if (entry.metadata?.type === 'TRIP_REFUND') {
          latestState = (entry.metadata.isPartial) ? 'ESCROWED' : 'REFUNDED';
          escrowPaise = Math.max(0, escrowPaise - entry.totalPaise);
        } else if (entry.metadata?.type === 'ESCROW_EXPIRY') {
          latestState = 'EXPIRED';
          escrowPaise = 0;
        } else if (entry.metadata?.type === 'TRIP_ADJUSTMENT') {
          latestState = 'ADJUSTED';
        }
      }

      const recovered = {
        paymentId,
        tripId,
        orderId: tripId,
        customerId: customerId || 'unknown',
        driverId,
        currency: 'INR',
        amountPaise: totalAmountPaise,
        escrowPaise,
        commissionBps: this.commissionConfig.commissionBps,
        commissionPaise,
        gstBps: this.commissionConfig.gstBps,
        gstPaise,
        driverEarningsPaise,
        state: latestState,
        version: relevantEntries.length + 1,
        transactionId: lastEntryId,
        createdAt: relevantEntries[0]?.createdAt || new Date().toISOString(),
        updatedAt: relevantEntries[relevantEntries.length - 1]?.createdAt || new Date().toISOString(),
        metadata: {}
      };

      this.transactions.set(paymentId, recovered);
      this.tripToPaymentMap.set(tripId, paymentId);
      return JSON.parse(JSON.stringify(recovered));
    } catch (_) {
      return null;
    }
  }

  /**
   * Central Legal Transition Gateway with Optimistic Concurrency Control
   */
  _transitionPayment({ paymentId, expectedState, nextState, expectedVersion, actor = 'SYSTEM', context = {} }) {
    const tx = this.transactions.get(paymentId);
    if (!tx) {
      throw new PaymentStateError(`Payment transaction not found: ${paymentId}`, 'PAYMENT_NOT_FOUND');
    }

    // 1. Strict State Machine Transition Guard
    const allowedNextStates = PAYMENT_TRANSITIONS[tx.state] || [];
    if (!allowedNextStates.includes(nextState)) {
      throw new PaymentStateError(
        `Illegal payment transition: ${tx.state} -> ${nextState} for payment ${paymentId}`,
        'ILLEGAL_PAYMENT_TRANSITION',
        { currentState: tx.state, attemptedState: nextState, paymentId }
      );
    }

    // 2. Expected State Precondition
    if (expectedState && tx.state !== expectedState) {
      throw new PaymentStateError(
        `Payment state conflict: expected state ${expectedState}, but found ${tx.state}`,
        'PAYMENT_STATE_CONFLICT',
        { expectedState, actualState: tx.state, paymentId }
      );
    }

    // 3. Optimistic Concurrency Control (Version Check)
    if (expectedVersion !== undefined && tx.version !== expectedVersion) {
      throw new PaymentStateError(
        `Optimistic lock failure: payment version ${tx.version} does not match expected version ${expectedVersion}`,
        'VERSION_CONFLICT',
        { expectedVersion, actualVersion: tx.version, paymentId }
      );
    }

    // Mutate state atomically
    const fromState = tx.state;
    tx.state = nextState;
    tx.version += 1;
    tx.updatedAt = new Date().toISOString();
    tx.lastTransition = {
      fromState,
      toState: nextState,
      actor,
      timestamp: tx.updatedAt,
      context
    };

    return JSON.parse(JSON.stringify(tx));
  }

  /**
   * 1. TOP-UP CUSTOMER WALLET
   * DR  cash:external          amount
   * CR  customer:{id}:wallet   amount
   */
  async topUpCustomerWallet({ customerId, amountPaise, idempotencyKey, referenceId = null }) {
    if (!customerId) throw new LedgerError('INVALID_CUSTOMER', 'customerId is required.');
    const customerAccount = this.getCustomerAccountId(customerId);
    this.ledger.ensureAccount(customerAccount, ACCOUNT_TYPES.LIABILITY);

    const ref = referenceId || `TOPUP_${idempotencyKey || Date.now()}`;
    const result = await this.ledger.postJournalEntry({
      referenceId: ref,
      idempotencyKey: idempotencyKey || ref,
      description: `Wallet top-up for customer ${customerId}`,
      postings: [
        { accountId: 'cash:external', side: 'DEBIT', amountPaise },
        { accountId: customerAccount, side: 'CREDIT', amountPaise },
      ],
      metadata: { customerId, type: 'TOP_UP' }
    });

    const bal = this.getCustomerBalance(customerId);
    return {
      success: true,
      transactionId: result.entryId,
      idempotentReplay: Boolean(result.idempotentReplay),
      customerId,
      amountPaise,
      newBalancePaise: bal.paise,
      newBalanceRupees: bal.rupees
    };
  }

  /**
   * 2. INITIATE PAYMENT TRANSACTION (Bound to real tripId & orderId)
   */
  initiatePayment({ tripId, orderId = null, customerId, amountPaise, metadata = {} }) {
    if (!tripId || !customerId) throw new PaymentStateError('tripId and customerId are required.', 'INVALID_PARAMS');
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      throw new PaymentStateError('amountPaise must be a positive integer.', 'INVALID_AMOUNT');
    }

    // Check if payment already exists for this trip
    if (this.tripToPaymentMap.has(tripId)) {
      const existingId = this.tripToPaymentMap.get(tripId);
      return this.getPayment(existingId);
    }

    const paymentId = `PAY_${tripId}`;
    const tx = {
      paymentId,
      tripId,
      orderId: orderId || tripId,
      customerId,
      driverId: null,
      currency: 'INR',
      amountPaise,
      escrowPaise: 0,
      commissionBps: this.commissionConfig.commissionBps,
      commissionPaise: 0,
      gstBps: this.commissionConfig.gstBps,
      gstPaise: 0,
      driverEarningsPaise: 0,
      state: 'INITIATED',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { ...metadata }
    };

    this.transactions.set(paymentId, tx);
    this.tripToPaymentMap.set(tripId, paymentId);
    return JSON.parse(JSON.stringify(tx));
  }

  /**
   * 3. RESERVE TRIP ESCROW (Booking)
   * DR  customer:{id}:wallet   amount
   * CR  escrow:platform        amount
   */
  async reserveEscrow({ tripId, orderId = null, customerId, amountPaise, idempotencyKey = null, expectedVersion = null }) {
    if (!tripId || !customerId) throw new PaymentStateError('tripId and customerId are required.', 'INVALID_PARAMS');
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      throw new PaymentStateError('amountPaise must be a positive integer.', 'INVALID_AMOUNT');
    }

    const paymentId = this.tripToPaymentMap.get(tripId) || `PAY_${tripId}`;

    return this._withPaymentLock(paymentId, async () => {
      let tx = this.getPaymentByTripId(tripId);
      if (!tx) {
        tx = this.initiatePayment({ tripId, orderId, customerId, amountPaise });
      }

      // Handle Idempotent Replay if already ESCROWED
      if (tx.state === 'ESCROWED') {
        if (amountPaise !== undefined && amountPaise !== null && amountPaise !== tx.escrowPaise) {
          throw new PaymentStateError(
            `Idempotency payload conflict: trip ${tripId} is already escrowed for ${tx.escrowPaise} paise, but requested ${amountPaise} paise.`,
            'IDEMPOTENCY_PAYLOAD_MISMATCH',
            { tripId, escrowPaise: tx.escrowPaise, requestedPaise: amountPaise }
          );
        }
        return {
          success: true,
          status: 'ESCROWED',
          tripId,
          paymentId: tx.paymentId,
          transactionId: tx.transactionId,
          idempotentReplay: true,
          amountPaise: tx.escrowPaise,
          customerBalance: this.getCustomerBalance(customerId),
          version: tx.version
        };
      }

      // Strict transition check: INITIATED -> ESCROWED
      this._transitionPayment({
        paymentId: tx.paymentId,
        expectedState: 'INITIATED',
        nextState: 'ESCROWED',
        expectedVersion: expectedVersion ?? tx.version,
        actor: 'CUSTOMER',
        context: { action: 'RESERVE_ESCROW', tripId }
      });

      const customerAccount = this.getCustomerAccountId(customerId);
      this.ledger.ensureAccount(customerAccount, ACCOUNT_TYPES.LIABILITY);

      const deterministicKey = idempotencyKey || `VAAYU:${tripId}:ESCROW`;
      let ledgerResult;
      try {
        ledgerResult = await this.ledger.postJournalEntry({
          referenceId: `TRIP_${tripId}_ESCROW`,
          idempotencyKey: deterministicKey,
          description: `Escrow hold for trip ${tripId}`,
          postings: [
            { accountId: customerAccount, side: 'DEBIT', amountPaise },
            { accountId: 'escrow:platform', side: 'CREDIT', amountPaise },
          ],
          metadata: { tripId, customerId, paymentId: tx.paymentId, type: 'TRIP_ESCROW' }
        });
      } catch (err) {
        // Rollback memory state if ledger rejects (e.g. INSUFFICIENT_FUNDS)
        const currentTx = this.transactions.get(tx.paymentId);
        if (currentTx) {
          currentTx.state = 'INITIATED';
          currentTx.version -= 1;
        }
        throw err;
      }

      const updatedTx = this.transactions.get(tx.paymentId);
      updatedTx.escrowPaise = amountPaise;
      updatedTx.transactionId = ledgerResult.entryId;

      const response = {
        success: true,
        status: 'ESCROWED',
        tripId,
        paymentId: tx.paymentId,
        transactionId: ledgerResult.entryId,
        idempotentReplay: Boolean(ledgerResult.idempotentReplay),
        amountPaise,
        customerBalance: this.getCustomerBalance(customerId),
        version: updatedTx.version
      };

      if (!ledgerResult.idempotentReplay) {
        this._emitDomainEvent('PaymentEscrowed', {
          paymentId: tx.paymentId,
          tripId,
          orderId: tx.orderId,
          customerId,
          amountPaise,
          escrowPaise: updatedTx.escrowPaise,
          version: updatedTx.version
        });
      }

      return response;
    });
  }

  /**
   * 4. SETTLE TRIP TO DRIVER WITH EXPLICIT COMMISSION & GST SPLIT
   * 
   * Trip fare              ₹500 (50,000 paise)
   * Platform commission     ₹50 ( 5,000 paise - 1000 bps)
   * GST on commission        ₹9 (   900 paise - 1800 bps)
   * Driver earnings        ₹441 (44,100 paise)
   * 
   * DR  escrow:platform          amount
   * CR  driver:{id}:earnings     driverEarningsPaise
   * CR  platform:commission      commissionPaise
   * CR  platform:gst             gstPaise
   */
  async settleTrip({ tripId, driverId, amountPaise = null, platformCommissionPaise = null, idempotencyKey = null, expectedVersion = null, actor = 'DISPATCH' }) {
    if (!tripId || !driverId) throw new PaymentStateError('tripId and driverId are required.', 'INVALID_PARAMS');
    const paymentId = this.tripToPaymentMap.get(tripId) || `PAY_${tripId}`;

    return this._withPaymentLock(paymentId, async () => {
      const tx = this.getPaymentByTripId(tripId);
      if (!tx) {
        throw new PaymentStateError(`No payment transaction exists for trip ${tripId}`, 'PAYMENT_NOT_FOUND');
      }

      // Handle Idempotent Replay if already SETTLED
      if (tx.state === 'SETTLED') {
        if (amountPaise !== undefined && amountPaise !== null && amountPaise !== tx.amountPaise) {
          throw new PaymentStateError(
            `Idempotency payload conflict: trip ${tripId} is already settled for ${tx.amountPaise} paise, but requested ${amountPaise} paise.`,
            'IDEMPOTENCY_PAYLOAD_MISMATCH',
            { tripId, settledPaise: tx.amountPaise, requestedPaise: amountPaise }
          );
        }
        return {
          success: true,
          status: 'SETTLED',
          tripId,
          paymentId: tx.paymentId,
          transactionId: tx.transactionId,
          idempotentReplay: true,
          totalFarePaise: tx.amountPaise,
          driverEarningsPaise: tx.driverEarningsPaise,
          commissionPaise: tx.commissionPaise,
          gstPaise: tx.gstPaise,
          driverBalance: this.getDriverBalance(driverId),
          version: tx.version
        };
      }

      // Strict transition check: ESCROWED -> SETTLED
      this._transitionPayment({
        paymentId: tx.paymentId,
        expectedState: 'ESCROWED',
        nextState: 'SETTLED',
        expectedVersion: expectedVersion ?? tx.version,
        actor,
        context: { action: 'SETTLE_TRIP', driverId }
      });

      const driverAccount = this.getDriverAccountId(driverId);
      this.ledger.ensureAccount(driverAccount, ACCOUNT_TYPES.LIABILITY);

      // Compute explicit commission & GST split in integer paise
      const settleAmountPaise = amountPaise ?? (tx.escrowPaise || tx.amountPaise);
      const commissionBps = tx.commissionBps ?? this.commissionConfig.commissionBps;
      const gstBps = tx.gstBps ?? this.commissionConfig.gstBps;

      let commissionPaise;
      let gstPaise;
      let driverEarningsPaise;

      if (platformCommissionPaise !== null && platformCommissionPaise !== undefined) {
        commissionPaise = platformCommissionPaise;
        gstPaise = Math.floor((commissionPaise * gstBps) / 10000);
        driverEarningsPaise = settleAmountPaise - commissionPaise - gstPaise;
      } else {
        commissionPaise = Math.floor((settleAmountPaise * commissionBps) / 10000);
        gstPaise = Math.floor((commissionPaise * gstBps) / 10000);
        driverEarningsPaise = settleAmountPaise - commissionPaise - gstPaise;
      }

      // Double-entry postings: DR debits === CR credits exactly
      const postings = [
        { accountId: 'escrow:platform', side: 'DEBIT', amountPaise: settleAmountPaise },
        { accountId: driverAccount, side: 'CREDIT', amountPaise: driverEarningsPaise },
      ];

      if (commissionPaise > 0) {
        postings.push({ accountId: 'platform:commission', side: 'CREDIT', amountPaise: commissionPaise });
      }
      if (gstPaise > 0) {
        postings.push({ accountId: 'platform:gst', side: 'CREDIT', amountPaise: gstPaise });
      }

      const deterministicKey = idempotencyKey || `VAAYU:${tripId}:SETTLEMENT`;
      let ledgerResult;
      try {
        ledgerResult = await this.ledger.postJournalEntry({
          referenceId: `TRIP_${tripId}_SETTLE`,
          idempotencyKey: deterministicKey,
          description: `Settlement for trip ${tripId} (Driver: ₹${(driverEarningsPaise/100).toFixed(2)}, Comm: ₹${(commissionPaise/100).toFixed(2)}, GST: ₹${(gstPaise/100).toFixed(2)})`,
          postings,
          metadata: {
            tripId,
            paymentId: tx.paymentId,
            driverId,
            commissionBps,
            commissionPaise,
            gstBps,
            gstPaise,
            driverEarningsPaise,
            type: 'TRIP_SETTLEMENT'
          }
        });
      } catch (err) {
        // Rollback memory state on ledger error
        const currentTx = this.transactions.get(tx.paymentId);
        if (currentTx) {
          currentTx.state = 'ESCROWED';
          currentTx.version -= 1;
        }
        throw err;
      }

      // Persist immutable historical snapshot
      const updatedTx = this.transactions.get(tx.paymentId);
      updatedTx.driverId = driverId;
      updatedTx.driverEarningsPaise = driverEarningsPaise;
      updatedTx.commissionPaise = commissionPaise;
      updatedTx.gstPaise = gstPaise;
      updatedTx.escrowPaise = 0;
      updatedTx.transactionId = ledgerResult.entryId;

      const response = {
        success: true,
        status: 'SETTLED',
        tripId,
        paymentId: tx.paymentId,
        transactionId: ledgerResult.entryId,
        idempotentReplay: Boolean(ledgerResult.idempotentReplay),
        totalFarePaise: settleAmountPaise,
        driverEarningsPaise,
        commissionPaise,
        gstPaise,
        driverBalance: this.getDriverBalance(driverId),
        version: updatedTx.version
      };

      if (!ledgerResult.idempotentReplay) {
        this._emitDomainEvent('PaymentSettled', {
          paymentId: tx.paymentId,
          tripId,
          orderId: tx.orderId,
          customerId: tx.customerId,
          driverId,
          amountPaise: settleAmountPaise,
          totalFarePaise: settleAmountPaise,
          driverEarningsPaise,
          commissionPaise,
          gstPaise,
          version: updatedTx.version
        });
      }

      return response;
    });
  }

  /**
   * 5. REFUND TRIP ESCROW (Before delivery - Full or Partial Fare Adjustment)
   * DR  escrow:platform        amount
   * CR  customer:{id}:wallet   amount
   */
  async refundTrip({ tripId, paymentId = null, amountPaise = null, reason = 'Trip cancelled', idempotencyKey = null, expectedVersion = null, actor = 'CUSTOMER' }) {
    if (!tripId && !paymentId) throw new PaymentStateError('tripId or paymentId is required.', 'INVALID_PARAMS');
    const resolvedPaymentId = paymentId || this.tripToPaymentMap.get(tripId) || `PAY_${tripId}`;

    return this._withPaymentLock(resolvedPaymentId, async () => {
      const tx = this.getPayment(resolvedPaymentId) || (tripId ? this.getPaymentByTripId(tripId) : null);
      if (!tx) {
        throw new PaymentStateError(`No payment transaction exists for trip ${tripId || resolvedPaymentId}`, 'PAYMENT_NOT_FOUND');
      }

      const deterministicKey = idempotencyKey || `VAAYU:${tx.tripId}:REFUND:${Date.now()}`;

      if (tx.state === 'REFUNDED') {
        if (tx.lastRefundIdempotencyKey === deterministicKey || tx.idempotencyKey === deterministicKey) {
          return {
            success: true,
            status: 'REFUNDED',
            isPartial: false,
            tripId: tx.tripId,
            paymentId: tx.paymentId,
            transactionId: tx.transactionId,
            idempotentReplay: true,
            refundedPaise: tx.refundedPaise || tx.amountPaise,
            totalRefundedPaise: tx.refundedPaise || tx.amountPaise,
            remainingEscrowPaise: 0,
            customerBalance: this.getCustomerBalance(tx.customerId),
            version: tx.version
          };
        }
        throw new PaymentStateError(
          `Cannot refund payment for trip ${tx.tripId}: transaction is already fully refunded and escrow is exhausted.`,
          'REFUND_LIMIT_EXCEEDED',
          { remainingEscrowPaise: 0, requestedPaise: amountPaise, paymentId: tx.paymentId }
        );
      }

      if (tx.state === 'SETTLED') {
        throw new PaymentStateError(
          `Cannot refund settled payment for trip ${tx.tripId}. Post-settlement issues must use dispute and adjustment.`,
          'ILLEGAL_PAYMENT_TRANSITION',
          { currentState: tx.state, attemptedAction: 'REFUND', paymentId: tx.paymentId }
        );
      }
      if (tx.state === 'EXPIRED') {
        throw new PaymentStateError(
          `Cannot refund expired payment for trip ${tx.tripId}. Escrow was already released upon expiry.`,
          'ILLEGAL_PAYMENT_TRANSITION',
          { currentState: tx.state, attemptedAction: 'REFUND', paymentId: tx.paymentId }
        );
      }

      const refundAmount = amountPaise ?? tx.escrowPaise;
      if (!Number.isSafeInteger(refundAmount) || refundAmount <= 0) {
        throw new PaymentStateError('Refund amount must be a positive integer in paise.', 'INVALID_AMOUNT');
      }

      // Strict invariant: refundedPaise + remainingEscrowPaise <= originalEscrowPaise
      if (refundAmount > tx.escrowPaise) {
        throw new PaymentStateError(
          `Refund amount (${refundAmount} paise) exceeds remaining escrow (${tx.escrowPaise} paise). Invariant violated: refundedPaise + remainingEscrowPaise <= originalEscrowPaise.`,
          'REFUND_LIMIT_EXCEEDED',
          { requestedPaise: refundAmount, remainingEscrowPaise: tx.escrowPaise, paymentId: tx.paymentId }
        );
      }

      const isFullRefund = (refundAmount === tx.escrowPaise);

      if (isFullRefund) {
        // Strict transition check: ESCROWED -> REFUNDED
        this._transitionPayment({
          paymentId: tx.paymentId,
          expectedState: 'ESCROWED',
          nextState: 'REFUNDED',
          expectedVersion: expectedVersion ?? tx.version,
          actor,
          context: { action: 'FULL_REFUND', reason, refundAmount }
        });
      } else {
        // Partial refund (Fare adjustment): remains in ESCROWED state, increment version for OCC
        if (expectedVersion !== undefined && expectedVersion !== null && tx.version !== expectedVersion) {
          throw new PaymentStateError(
            `Optimistic lock failure: payment version ${tx.version} does not match expected version ${expectedVersion}`,
            'VERSION_CONFLICT',
            { expectedVersion, actualVersion: tx.version, paymentId: tx.paymentId }
          );
        }
        tx.version += 1;
        tx.updatedAt = new Date().toISOString();
        this.transactions.set(tx.paymentId, tx);
      }

      const customerAccount = this.getCustomerAccountId(tx.customerId);
      this.ledger.ensureAccount(customerAccount, ACCOUNT_TYPES.LIABILITY);

      let ledgerResult;
      try {
        ledgerResult = await this.ledger.postJournalEntry({
          referenceId: `TRIP_${tx.tripId}_REFUND`,
          idempotencyKey: deterministicKey,
          description: `Refund for trip ${tx.tripId}: ${reason}`,
          postings: [
            { accountId: 'escrow:platform', side: 'DEBIT', amountPaise: refundAmount },
            { accountId: customerAccount, side: 'CREDIT', amountPaise: refundAmount },
          ],
          metadata: { tripId: tx.tripId, paymentId: tx.paymentId, customerId: tx.customerId, reason, isPartial: !isFullRefund, type: 'TRIP_REFUND' }
        });
      } catch (err) {
        const currentTx = this.transactions.get(tx.paymentId);
        if (currentTx) {
          if (isFullRefund) {
            currentTx.state = 'ESCROWED';
          }
          currentTx.version -= 1;
        }
        throw err;
      }

      const updatedTx = this.transactions.get(tx.paymentId);
      updatedTx.escrowPaise = Math.max(0, updatedTx.escrowPaise - refundAmount);
      updatedTx.refundedPaise = (updatedTx.refundedPaise || 0) + refundAmount;
      updatedTx.transactionId = ledgerResult.entryId;
      if (isFullRefund) {
        updatedTx.lastRefundIdempotencyKey = deterministicKey;
      }

      const response = {
        success: true,
        status: isFullRefund ? 'REFUNDED' : 'ESCROWED',
        isPartial: !isFullRefund,
        tripId: tx.tripId,
        paymentId: tx.paymentId,
        transactionId: ledgerResult.entryId,
        idempotentReplay: Boolean(ledgerResult.idempotentReplay),
        refundedPaise: refundAmount,
        totalRefundedPaise: updatedTx.refundedPaise,
        remainingEscrowPaise: updatedTx.escrowPaise,
        customerBalance: this.getCustomerBalance(tx.customerId),
        version: updatedTx.version
      };

      if (!ledgerResult.idempotentReplay) {
        this._emitDomainEvent(isFullRefund ? 'PaymentRefunded' : 'PaymentPartiallyRefunded', {
          paymentId: tx.paymentId,
          tripId: tx.tripId,
          orderId: tx.orderId,
          customerId: tx.customerId,
          refundedPaise: refundAmount,
          totalRefundedPaise: updatedTx.refundedPaise,
          remainingEscrowPaise: updatedTx.escrowPaise,
          reason,
          version: updatedTx.version
        });
      }

      return response;
    });
  }

  /**
   * 6. EXPIRE ABANDONED ESCROW (Search timeout or SLA expiry)
   * ESCROWED -> EXPIRED
   * DR  escrow:platform        amount
   * CR  customer:{id}:wallet   amount
   */
  async expirePayment({ paymentId = null, tripId = null, reason = 'Dispatch search timed out', idempotencyKey = null, expectedVersion = null, actor = 'DISPATCH_TIMEOUT_WORKER' }) {
    if (!paymentId && !tripId) throw new PaymentStateError('paymentId or tripId is required.', 'INVALID_PARAMS');
    const resolvedPaymentId = paymentId || this.tripToPaymentMap.get(tripId) || `PAY_${tripId}`;

    return this._withPaymentLock(resolvedPaymentId, async () => {
      const tx = this.getPayment(resolvedPaymentId) || (tripId ? this.getPaymentByTripId(tripId) : null);
      if (!tx) {
        throw new PaymentStateError(`No payment transaction exists for trip ${tripId || resolvedPaymentId}`, 'PAYMENT_NOT_FOUND');
      }

      if (tx.state === 'EXPIRED') {
        return {
          success: true,
          status: 'EXPIRED',
          tripId: tx.tripId,
          paymentId: tx.paymentId,
          transactionId: tx.transactionId,
          idempotentReplay: true,
          releasedPaise: 0,
          customerBalance: this.getCustomerBalance(tx.customerId),
          version: tx.version
        };
      }

      // Strict transition check: ESCROWED -> EXPIRED (throws ILLEGAL_PAYMENT_TRANSITION if e.g. SETTLED)
      this._transitionPayment({
        paymentId: tx.paymentId,
        expectedState: 'ESCROWED',
        nextState: 'EXPIRED',
        expectedVersion: expectedVersion ?? tx.version,
        actor,
        context: { action: 'EXPIRE_PAYMENT', reason }
      });

      const refundAmount = tx.escrowPaise;
      const customerAccount = this.getCustomerAccountId(tx.customerId);
      this.ledger.ensureAccount(customerAccount, ACCOUNT_TYPES.LIABILITY);

      const deterministicKey = idempotencyKey || `VAAYU:${tx.tripId}:EXPIRY`;
      let ledgerResult = { entryId: tx.transactionId, idempotentReplay: false };

      if (refundAmount > 0) {
        try {
          ledgerResult = await this.ledger.postJournalEntry({
            referenceId: `TRIP_${tx.tripId}_EXPIRY`,
            idempotencyKey: deterministicKey,
            description: `Auto-expiry release for abandoned trip ${tx.tripId}: ${reason}`,
            postings: [
              { accountId: 'escrow:platform', side: 'DEBIT', amountPaise: refundAmount },
              { accountId: customerAccount, side: 'CREDIT', amountPaise: refundAmount },
            ],
            metadata: { tripId: tx.tripId, paymentId: tx.paymentId, customerId: tx.customerId, type: 'ESCROW_EXPIRY' }
          });
        } catch (err) {
          const currentTx = this.transactions.get(tx.paymentId);
          if (currentTx) {
            currentTx.state = 'ESCROWED';
            currentTx.version -= 1;
          }
          throw err;
        }
      }

      const updatedTx = this.transactions.get(tx.paymentId);
      updatedTx.escrowPaise = 0;
      updatedTx.releasedPaise = refundAmount;
      updatedTx.transactionId = ledgerResult.entryId;

      const response = {
        success: true,
        status: 'EXPIRED',
        tripId: tx.tripId,
        paymentId: tx.paymentId,
        transactionId: ledgerResult.entryId,
        idempotentReplay: Boolean(ledgerResult.idempotentReplay),
        releasedPaise: refundAmount,
        customerBalance: this.getCustomerBalance(tx.customerId),
        version: updatedTx.version
      };

      if (!ledgerResult.idempotentReplay) {
        this._emitDomainEvent('PaymentExpired', {
          paymentId: tx.paymentId,
          tripId: tx.tripId,
          orderId: tx.orderId,
          customerId: tx.customerId,
          releasedPaise: refundAmount,
          reason,
          version: updatedTx.version
        });
      }

      return response;
    });
  }

  async expireEscrow(params) {
    return this.expirePayment(params);
  }

  /**
   * 7. DISPUTE SETTLED PAYMENT (Post-settlement Customer / Partner Complaint)
   * SETTLED -> DISPUTED
   */
  async disputePayment({ paymentId = null, tripId = null, disputeId, reason = 'Customer disputed trip charges', idempotencyKey = null, expectedVersion = null, actor = 'CUSTOMER_SUPPORT' }) {
    if (!disputeId) throw new PaymentStateError('disputeId is required.', 'INVALID_PARAMS');
    if (!paymentId && !tripId) throw new PaymentStateError('paymentId or tripId is required.', 'INVALID_PARAMS');
    const resolvedPaymentId = paymentId || this.tripToPaymentMap.get(tripId) || `PAY_${tripId}`;

    return this._withPaymentLock(resolvedPaymentId, async () => {
      const tx = this.getPayment(resolvedPaymentId) || (tripId ? this.getPaymentByTripId(tripId) : null);
      if (!tx) {
        throw new PaymentStateError(`No payment transaction exists for trip ${tripId || resolvedPaymentId}`, 'PAYMENT_NOT_FOUND');
      }

      // Replay idempotency: already disputed with same disputeId
      if (tx.state === 'DISPUTED' && tx.disputeId === disputeId) {
        return {
          success: true,
          status: 'DISPUTED',
          tripId: tx.tripId,
          paymentId: tx.paymentId,
          disputeId: tx.disputeId,
          reason: tx.disputeReason,
          idempotentReplay: true,
          version: tx.version
        };
      }

      // Strict transition: SETTLED -> DISPUTED (rejects if e.g. ESCROWED, REFUNDED, EXPIRED, ADJUSTED)
      this._transitionPayment({
        paymentId: tx.paymentId,
        expectedState: 'SETTLED',
        nextState: 'DISPUTED',
        expectedVersion: expectedVersion ?? tx.version,
        actor,
        context: { action: 'DISPUTE_PAYMENT', disputeId, reason }
      });

      const updatedTx = this.transactions.get(tx.paymentId);
      updatedTx.disputeId = disputeId;
      updatedTx.disputeReason = reason;
      updatedTx.disputeCreatedAt = new Date().toISOString();
      updatedTx.disputeActor = actor;

      const response = {
        success: true,
        status: 'DISPUTED',
        tripId: tx.tripId,
        paymentId: tx.paymentId,
        disputeId,
        reason,
        idempotentReplay: false,
        version: updatedTx.version
      };

      this._emitDomainEvent('PaymentDisputed', {
        paymentId: tx.paymentId,
        tripId: tx.tripId,
        orderId: tx.orderId,
        customerId: tx.customerId,
        driverId: tx.driverId,
        disputeId,
        reason,
        version: updatedTx.version
      });

      return response;
    });
  }

  /**
   * 8. ADJUST DISPUTED PAYMENT (Post-settlement Financial Resolution)
   * DISPUTED -> ADJUSTED
   * Invariant: customerCreditPaise === (driverDebitPaise + platformDebitPaise + taxAdjustmentPaise)
   */
  async adjustPayment({ paymentId = null, tripId = null, disputeId, adjustmentPaise = null, allocations, reason = 'Dispute resolution adjustment', idempotencyKey = null, expectedVersion = null, actor = 'ADMIN_SETTLEMENT' }) {
    if (!disputeId) throw new PaymentStateError('disputeId is required.', 'INVALID_PARAMS');
    if (!allocations || typeof allocations !== 'object') {
      throw new PaymentStateError('allocations object is required for adjustment.', 'INVALID_ADJUSTMENT_ALLOCATION');
    }
    if (!paymentId && !tripId) throw new PaymentStateError('paymentId or tripId is required.', 'INVALID_PARAMS');
    const resolvedPaymentId = paymentId || this.tripToPaymentMap.get(tripId) || `PAY_${tripId}`;

    return this._withPaymentLock(resolvedPaymentId, async () => {
      const tx = this.getPayment(resolvedPaymentId) || (tripId ? this.getPaymentByTripId(tripId) : null);
      if (!tx) {
        throw new PaymentStateError(`No payment transaction exists for trip ${tripId || resolvedPaymentId}`, 'PAYMENT_NOT_FOUND');
      }

      // Replay idempotency: already adjusted with same disputeId
      if (tx.state === 'ADJUSTED') {
        if (tx.disputeId === disputeId) {
          return {
            success: true,
            status: 'ADJUSTED',
            tripId: tx.tripId,
            paymentId: tx.paymentId,
            disputeId: tx.disputeId,
            transactionId: tx.transactionId,
            idempotentReplay: true,
            adjustmentPaise: tx.adjustments?.[0]?.adjustmentPaise || 0,
            allocations: tx.adjustments?.[0]?.allocations || allocations,
            customerBalance: this.getCustomerBalance(tx.customerId),
            driverBalance: tx.driverId ? this.getDriverBalance(tx.driverId) : null,
            version: tx.version
          };
        } else {
          throw new PaymentStateError(
            `Payment ${tx.paymentId} has already been adjusted under dispute ${tx.disputeId}`,
            'DISPUTE_ALREADY_ADJUSTED'
          );
        }
      }

      // Allocation invariant validations
      const customerCredit = allocations.customerCreditPaise;
      const driverDebit = allocations.driverDebitPaise || 0;
      const platformDebit = allocations.platformDebitPaise || 0;
      const taxAdjustment = allocations.taxAdjustmentPaise || 0;

      if (!Number.isSafeInteger(customerCredit) || customerCredit <= 0) {
        throw new PaymentStateError('customerCreditPaise must be a positive integer in paise.', 'INVALID_ADJUSTMENT_ALLOCATION');
      }
      if (!Number.isSafeInteger(driverDebit) || driverDebit < 0 ||
          !Number.isSafeInteger(platformDebit) || platformDebit < 0 ||
          !Number.isSafeInteger(taxAdjustment) || taxAdjustment < 0) {
        throw new PaymentStateError('Allocations debit amounts must be non-negative integers.', 'INVALID_ADJUSTMENT_ALLOCATION');
      }

      const sumDebits = driverDebit + platformDebit + taxAdjustment;
      if (customerCredit !== sumDebits) {
        throw new PaymentStateError(
          `Allocation mismatch: customerCreditPaise (${customerCredit}) must exactly equal sum of debits (${sumDebits}) [driver: ${driverDebit}, platform: ${platformDebit}, tax: ${taxAdjustment}].`,
          'INVALID_ADJUSTMENT_ALLOCATION',
          { customerCredit, driverDebit, platformDebit, taxAdjustment, sumDebits }
        );
      }

      if (adjustmentPaise !== null && adjustmentPaise !== undefined && adjustmentPaise !== customerCredit) {
        throw new PaymentStateError(
          `adjustmentPaise (${adjustmentPaise}) does not match customerCreditPaise (${customerCredit}).`,
          'INVALID_ADJUSTMENT_ALLOCATION'
        );
      }

      if (driverDebit > tx.driverEarningsPaise) {
        throw new PaymentStateError(
          `Driver debit (${driverDebit} paise) exceeds driver earnings (${tx.driverEarningsPaise} paise) for trip ${tx.tripId}.`,
          'ADJUSTMENT_EXCEEDS_EARNINGS',
          { driverDebit, driverEarningsPaise: tx.driverEarningsPaise }
        );
      }

      if (customerCredit > tx.amountPaise) {
        throw new PaymentStateError(
          `Customer adjustment credit (${customerCredit} paise) exceeds total original trip fare (${tx.amountPaise} paise).`,
          'ADJUSTMENT_EXCEEDS_FARE',
          { customerCredit, originalFarePaise: tx.amountPaise }
        );
      }

      // Strict transition: DISPUTED -> ADJUSTED
      this._transitionPayment({
        paymentId: tx.paymentId,
        expectedState: 'DISPUTED',
        nextState: 'ADJUSTED',
        expectedVersion: expectedVersion ?? tx.version,
        actor,
        context: { action: 'ADJUST_PAYMENT', disputeId, allocations, reason }
      });

      // Post double-entry balancing journal entry (compensatory entries; original settlement stays immutable)
      const postings = [];
      if (driverDebit > 0) {
        const driverAccount = this.getDriverAccountId(tx.driverId);
        this.ledger.ensureAccount(driverAccount, ACCOUNT_TYPES.LIABILITY);
        postings.push({ accountId: driverAccount, side: 'DEBIT', amountPaise: driverDebit });
      }
      if (platformDebit > 0) {
        postings.push({ accountId: 'platform:commission', side: 'DEBIT', amountPaise: platformDebit });
      }
      if (taxAdjustment > 0) {
        postings.push({ accountId: 'platform:gst', side: 'DEBIT', amountPaise: taxAdjustment });
      }

      const customerAccount = this.getCustomerAccountId(tx.customerId);
      this.ledger.ensureAccount(customerAccount, ACCOUNT_TYPES.LIABILITY);
      postings.push({ accountId: customerAccount, side: 'CREDIT', amountPaise: customerCredit });

      const deterministicKey = idempotencyKey || `VAAYU:${tx.tripId}:ADJUSTMENT:${disputeId}`;
      let ledgerResult;
      try {
        ledgerResult = await this.ledger.postJournalEntry({
          referenceId: `TRIP_${tx.tripId}_ADJUST_${disputeId}`,
          idempotencyKey: deterministicKey,
          description: `Dispute adjustment for trip ${tx.tripId} (${disputeId}): ${reason}`,
          postings,
          metadata: {
            tripId: tx.tripId,
            paymentId: tx.paymentId,
            disputeId,
            allocations,
            type: 'TRIP_ADJUSTMENT'
          }
        });
      } catch (err) {
        const currentTx = this.transactions.get(tx.paymentId);
        if (currentTx) {
          currentTx.state = 'DISPUTED';
          currentTx.version -= 1;
        }
        throw err;
      }

      const updatedTx = this.transactions.get(tx.paymentId);
      updatedTx.adjustments = updatedTx.adjustments || [];
      updatedTx.adjustments.push({
        disputeId,
        adjustmentPaise: customerCredit,
        allocations: { ...allocations },
        reason,
        actor,
        timestamp: new Date().toISOString(),
        transactionId: ledgerResult.entryId
      });
      updatedTx.transactionId = ledgerResult.entryId;

      const response = {
        success: true,
        status: 'ADJUSTED',
        tripId: tx.tripId,
        paymentId: tx.paymentId,
        disputeId,
        transactionId: ledgerResult.entryId,
        idempotentReplay: Boolean(ledgerResult.idempotentReplay),
        adjustmentPaise: customerCredit,
        allocations,
        customerBalance: this.getCustomerBalance(tx.customerId),
        driverBalance: tx.driverId ? this.getDriverBalance(tx.driverId) : null,
        version: updatedTx.version
      };

      if (!ledgerResult.idempotentReplay) {
        this._emitDomainEvent('PaymentAdjusted', {
          paymentId: tx.paymentId,
          tripId: tx.tripId,
          orderId: tx.orderId,
          customerId: tx.customerId,
          driverId: tx.driverId,
          disputeId,
          adjustmentPaise: customerCredit,
          allocations,
          reason,
          version: updatedTx.version
        });
      }

      return response;
    });
  }

  /**
   * 7. REQUEST DRIVER PAYOUT
   * DR  driver:{id}:earnings   amount
   * CR  payout:clearing         amount
   */
  async requestPayout({ driverId, amountPaise, upiId, idempotencyKey = null, referenceId = null }) {
    if (!driverId || !upiId) throw new LedgerError('INVALID_PARAMS', 'driverId and upiId are required.');
    const driverAccount = this.getDriverAccountId(driverId);
    this.ledger.ensureAccount(driverAccount, ACCOUNT_TYPES.LIABILITY);

    const payoutId = referenceId || `PAY_${idempotencyKey || Date.now()}`;
    const key = idempotencyKey || `PAYOUT_${payoutId}`;

    const result = await this.ledger.postJournalEntry({
      referenceId: payoutId,
      idempotencyKey: key,
      description: `Instant UPI payout for driver ${driverId} to ${upiId}`,
      postings: [
        { accountId: driverAccount, side: 'DEBIT', amountPaise },
        { accountId: 'payout:clearing', side: 'CREDIT', amountPaise },
      ],
      metadata: { payoutId, driverId, upiId, type: 'PAYOUT_REQUEST' }
    });

    return {
      success: true,
      status: 'PENDING_CLEARING',
      payoutId,
      transactionId: result.entryId,
      idempotentReplay: Boolean(result.idempotentReplay),
      amountPaise,
      driverBalance: this.getDriverBalance(driverId),
      clearingBalancePaise: this.ledger.getAccount('payout:clearing').balancePaise
    };
  }

  /**
   * 8. SETTLE PAYOUT (Disbursement)
   * DR  payout:clearing        amount
   * CR  cash:external          amount
   */
  async settlePayout({ payoutId, amountPaise, idempotencyKey = null }) {
    if (!payoutId) throw new LedgerError('INVALID_PARAMS', 'payoutId is required.');
    const key = idempotencyKey || `DISBURSE_${payoutId}`;

    const result = await this.ledger.postJournalEntry({
      referenceId: `DISBURSE_${payoutId}`,
      idempotencyKey: key,
      description: `Disbursed payout ${payoutId} via banking rail`,
      postings: [
        { accountId: 'payout:clearing', side: 'DEBIT', amountPaise },
        { accountId: 'cash:external', side: 'CREDIT', amountPaise },
      ],
      metadata: { payoutId, type: 'PAYOUT_DISBURSED' }
    });

    return {
      success: true,
      status: 'SETTLED',
      payoutId,
      transactionId: result.entryId,
      idempotentReplay: Boolean(result.idempotentReplay),
      amountPaise
    };
  }

  reconcile() {
    return this.ledger.reconcile();
  }

  reconcileDetailed() {
    const rec = this.ledger.reconcile();
    const state = this.ledger.repository.snapshot();
    let totalDebitsPaise = 0;
    let totalCreditsPaise = 0;
    for (const entry of (state.journalEntries || [])) {
      for (const p of (entry.postings || [])) {
        if (p.side === 'DEBIT') totalDebitsPaise += p.amountPaise;
        else totalCreditsPaise += p.amountPaise;
      }
    }
    return {
      ok: rec.ok,
      problems: rec.problems || [],
      journalEntriesCount: rec.journalEntries,
      accountsCount: Object.keys(state.accounts || {}).length,
      totalDebitsPaise,
      totalCreditsPaise,
      balanced: (totalDebitsPaise === totalCreditsPaise),
      timestamp: new Date().toISOString()
    };
  }

  getLedgerAudit() {
    const state = this.ledger.repository.snapshot();
    const accounts = state.accounts || {};

    const getAcc = (id) => accounts[id] || { accountId: id, balancePaise: 0, debitPaise: 0, creditPaise: 0 };

    const escrowPlatform = getAcc('escrow:platform');
    const platformCommission = getAcc('platform:commission');
    const platformGst = getAcc('platform:gst');
    const payoutClearing = getAcc('payout:clearing');
    const cashExternal = getAcc('cash:external');

    let customerWalletsCount = 0;
    let customerWalletsBalancePaise = 0;
    let driverEarningsCount = 0;
    let driverEarningsBalancePaise = 0;

    for (const [id, acc] of Object.entries(accounts)) {
      if (id.startsWith('customer:') && id.endsWith(':wallet')) {
        customerWalletsCount++;
        customerWalletsBalancePaise += acc.balancePaise;
      } else if (id.startsWith('driver:') && id.endsWith(':earnings')) {
        driverEarningsCount++;
        driverEarningsBalancePaise += acc.balancePaise;
      }
    }

    let totalDebitsPaise = 0;
    let totalCreditsPaise = 0;
    for (const entry of (state.journalEntries || [])) {
      for (const p of (entry.postings || [])) {
        if (p.side === 'DEBIT') totalDebitsPaise += p.amountPaise;
        else totalCreditsPaise += p.amountPaise;
      }
    }

    const totalAssetsPaise = cashExternal.balancePaise;
    const totalLiabilitiesPaise = escrowPlatform.balancePaise + platformGst.balancePaise + payoutClearing.balancePaise + customerWalletsBalancePaise + driverEarningsBalancePaise;
    const totalEquityRevenuePaise = platformCommission.balancePaise;

    const expectedGstPaise = Math.floor((platformCommission.balancePaise * this.commissionConfig.gstBps) / 10000);

    return {
      systemAccounts: {
        escrowPlatform: { accountId: 'escrow:platform', balancePaise: escrowPlatform.balancePaise, balanceRupees: +(escrowPlatform.balancePaise / 100).toFixed(2) },
        platformCommission: { accountId: 'platform:commission', balancePaise: platformCommission.balancePaise, balanceRupees: +(platformCommission.balancePaise / 100).toFixed(2) },
        platformGst: { accountId: 'platform:gst', balancePaise: platformGst.balancePaise, balanceRupees: +(platformGst.balancePaise / 100).toFixed(2) },
        payoutClearing: { accountId: 'payout:clearing', balancePaise: payoutClearing.balancePaise, balanceRupees: +(payoutClearing.balancePaise / 100).toFixed(2) },
        cashExternal: { accountId: 'cash:external', balancePaise: cashExternal.balancePaise, balanceRupees: +(cashExternal.balancePaise / 100).toFixed(2) }
      },
      aggregatedAccounts: {
        customerWallets: { count: customerWalletsCount, totalBalancePaise: customerWalletsBalancePaise, totalBalanceRupees: +(customerWalletsBalancePaise / 100).toFixed(2) },
        driverEarnings: { count: driverEarningsCount, totalBalancePaise: driverEarningsBalancePaise, totalBalanceRupees: +(driverEarningsBalancePaise / 100).toFixed(2) }
      },
      invariants: {
        debitsEqualCredits: (totalDebitsPaise === totalCreditsPaise),
        totalDebitsPaise,
        totalCreditsPaise,
        accountingEquationSatisfied: (totalAssetsPaise === totalLiabilitiesPaise + totalEquityRevenuePaise),
        totalAssetsPaise,
        totalLiabilitiesPaise,
        totalEquityRevenuePaise
      },
      statutoryGst: {
        commissionPaise: platformCommission.balancePaise,
        gstPaise: platformGst.balancePaise,
        configuredGstBps: this.commissionConfig.gstBps,
        expectedGstPaise,
        ratioCompliant: (platformGst.balancePaise === expectedGstPaise)
      },
      timestamp: new Date().toISOString()
    };
  }

  _getAllTransactions() {
    try {
      const state = this.ledger.repository.snapshot();
      for (const entry of (state.journalEntries || [])) {
        const pid = entry.metadata?.paymentId;
        if (pid && !this.transactions.has(pid)) {
          this.getPayment(pid);
        }
      }
    } catch (_) {}
    return Array.from(this.transactions.values());
  }

  queryTransactions({ tripId, state, customerId, driverId, limit = 50, offset = 0 } = {}) {
    let list = this._getAllTransactions();

    if (tripId) {
      list = list.filter(t => t.tripId === tripId || t.orderId === tripId || t.paymentId === tripId);
    }
    if (state) {
      list = list.filter(t => t.state === state);
    }
    if (customerId) {
      list = list.filter(t => t.customerId === customerId);
    }
    if (driverId) {
      list = list.filter(t => t.driverId === driverId);
    }

    list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

    const total = list.length;
    const numLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const numOffset = Math.max(0, parseInt(offset, 10) || 0);
    const paged = list.slice(numOffset, numOffset + numLimit);

    return {
      count: paged.length,
      total,
      limit: numLimit,
      offset: numOffset,
      transactions: JSON.parse(JSON.stringify(paged))
    };
  }

  getFinancialStats() {
    const allTxs = this._getAllTransactions();
    let gmvPaise = 0;
    let settledEarningsPaise = 0;
    let refundedPaise = 0;
    let disputedPaise = 0;
    let adjustedPaise = 0;

    const byState = {
      INITIATED: 0,
      ESCROWED: 0,
      SETTLED: 0,
      REFUNDED: 0,
      EXPIRED: 0,
      DISPUTED: 0,
      ADJUSTED: 0
    };

    for (const tx of allTxs) {
      if (byState[tx.state] !== undefined) {
        byState[tx.state]++;
      }
      gmvPaise += (tx.amountPaise || 0);

      if (tx.state === 'SETTLED' || tx.state === 'DISPUTED' || tx.state === 'ADJUSTED') {
        settledEarningsPaise += (tx.driverEarningsPaise || 0);
      }
      if (tx.refundedPaise) {
        refundedPaise += tx.refundedPaise;
      } else if (tx.state === 'REFUNDED') {
        refundedPaise += (tx.amountPaise || 0);
      }
      if (tx.state === 'DISPUTED') {
        disputedPaise += (tx.amountPaise || 0);
      }
      if (tx.state === 'ADJUSTED') {
        adjustedPaise += (tx.adjustmentPaise || 0);
      }
    }

    const escrowBalance = this.getBalance('escrow:platform');
    const commissionBalance = this.getBalance('platform:commission');
    const gstBalance = this.getBalance('platform:gst');

    return {
      gmv: { paise: gmvPaise, rupees: +(gmvPaise / 100).toFixed(2) },
      activeEscrow: { paise: escrowBalance, rupees: +(escrowBalance / 100).toFixed(2) },
      settledEarnings: { paise: settledEarningsPaise, rupees: +(settledEarningsPaise / 100).toFixed(2) },
      platformCommission: { paise: commissionBalance, rupees: +(commissionBalance / 100).toFixed(2) },
      statutoryGst: { paise: gstBalance, rupees: +(gstBalance / 100).toFixed(2) },
      refunded: { paise: refundedPaise, rupees: +(refundedPaise / 100).toFixed(2) },
      disputed: { paise: disputedPaise, rupees: +(disputedPaise / 100).toFixed(2) },
      adjusted: { paise: adjustedPaise, rupees: +(adjustedPaise / 100).toFixed(2) },
      totalTransactions: allTxs.length,
      byState
    };
  }
}

module.exports = {
  PaymentStateMachine,
  PaymentStateError,
  PAYMENT_TRANSITIONS,
  DEFAULT_COMMISSION_CONFIG
};
