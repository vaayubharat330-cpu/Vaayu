'use strict';

const crypto = require('crypto');
const { PostgresPool } = require('../../db/postgresClient');
const { LedgerError, ACCOUNT_TYPES, NORMAL_BALANCE } = require('./ledgerService');

class PostgresLedgerRepository {
  constructor(poolOrConfig) {
    if (poolOrConfig && typeof poolOrConfig.query === 'function') {
      this.pool = poolOrConfig;
    } else {
      this.pool = new PostgresPool(poolOrConfig || {});
    }
  }

  _requestHash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  async ensureAccount(accountId, accountType = ACCOUNT_TYPES.LIABILITY, normalBalance = null) {
    const normal = normalBalance || NORMAL_BALANCE[accountType] || 'CREDIT';
    const sql = `
      INSERT INTO ledger_accounts (account_id, account_type, normal_balance, balance_paise, debit_paise, credit_paise, version, created_at, updated_at)
      VALUES ($1, $2, $3, 0, 0, 0, 1, NOW(), NOW())
      ON CONFLICT (account_id) DO NOTHING
      RETURNING *;
    `;
    const res = await this.pool.query(sql, [accountId, accountType, normal]);
    if (res.rows.length > 0) return this._mapAccount(res.rows[0]);
    return await this.getAccount(accountId);
  }

  async getAccount(accountId) {
    const res = await this.pool.query('SELECT * FROM ledger_accounts WHERE account_id = $1', [accountId]);
    if (res.rows.length === 0) {
      throw new LedgerError('ACCOUNT_NOT_FOUND', `Account not found: ${accountId}`);
    }
    return this._mapAccount(res.rows[0]);
  }

  _mapAccount(row) {
    return {
      accountId: row.account_id,
      accountType: row.account_type,
      normalBalance: row.normal_balance,
      balancePaise: Number(row.balance_paise),
      debitPaise: Number(row.debit_paise),
      creditPaise: Number(row.credit_paise),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * Internal shared execution engine for posting double-entry entries
   * inside an active PostgreSQL transaction client with row locks and OCC.
   */
  async _executePostingsWithinClient(client, {
    referenceId,
    idempotencyKey,
    description,
    postings,
    metadata = {},
    paymentRecord = null,
    outboxEvent = null
  }) {
    // 1. Validate postings & double-entry invariant
    let totalDebits = 0;
    let totalCredits = 0;
    const normalized = [];

    for (let i = 0; i < postings.length; i++) {
      const p = postings[i];
      if (!p.accountId || !['DEBIT', 'CREDIT'].includes(p.side)) {
        throw new LedgerError('INVALID_POSTING', `Invalid posting at index ${i}.`);
      }
      const amt = Number(p.amountPaise);
      if (!Number.isSafeInteger(amt) || amt <= 0) {
        throw new LedgerError('INVALID_AMOUNT', `Amount must be a positive integer number of paise at index ${i}.`);
      }
      if (p.side === 'DEBIT') totalDebits += amt;
      else totalCredits += amt;

      normalized.push({
        postingId: crypto.randomUUID ? crypto.randomUUID() : `PST_${Date.now()}_${i}`,
        accountId: p.accountId,
        side: p.side,
        amountPaise: amt,
        metadata: p.metadata || {}
      });
    }

    if (totalDebits !== totalCredits) {
      throw new LedgerError('UNBALANCED_ENTRY', `Debits (${totalDebits}) must equal credits (${totalCredits}).`, {
        debits: totalDebits,
        credits: totalCredits
      });
    }

    // 2. Deterministic Account Locking (Alphabetical Order)
    const uniqueAccountIds = [...new Set(normalized.map(p => p.accountId))].sort();

    for (const accId of uniqueAccountIds) {
      await client.query(`
        INSERT INTO ledger_accounts (account_id, account_type, normal_balance, balance_paise, debit_paise, credit_paise, version)
        VALUES ($1, 'LIABILITY', 'CREDIT', 0, 0, 0, 1)
        ON CONFLICT (account_id) DO NOTHING;
      `, [accId]);
    }

    const lockedRes = await client.query(`
      SELECT account_id, normal_balance, balance_paise, debit_paise, credit_paise, version
      FROM ledger_accounts
      WHERE account_id = ANY($1)
      ORDER BY account_id
      FOR UPDATE;
    `, [uniqueAccountIds]);

    const lockedAccounts = new Map();
    for (const row of lockedRes.rows) {
      lockedAccounts.set(row.account_id, {
        accountId: row.account_id,
        normalBalance: row.normal_balance,
        balancePaise: Number(row.balance_paise),
        debitPaise: Number(row.debit_paise),
        creditPaise: Number(row.credit_paise),
        version: row.version
      });
    }

    // 3. Compute New Materialized Balances & Overdraft Check
    const accountDeltas = new Map();
    for (const accId of uniqueAccountIds) {
      const acc = lockedAccounts.get(accId);
      accountDeltas.set(accId, {
        balancePaise: acc.balancePaise,
        addDebitPaise: 0,
        addCreditPaise: 0
      });
    }

    for (const p of normalized) {
      const delta = accountDeltas.get(p.accountId);
      const acc = lockedAccounts.get(p.accountId);

      if (p.side === 'DEBIT') delta.addDebitPaise += p.amountPaise;
      else delta.addCreditPaise += p.amountPaise;

      if (acc.normalBalance === p.side) {
        delta.balancePaise += p.amountPaise;
      } else {
        delta.balancePaise -= p.amountPaise;
      }

      if (delta.balancePaise < 0) {
        throw new LedgerError('INSUFFICIENT_FUNDS', `Insufficient balance in ${acc.accountId}.`, {
          accountId: acc.accountId,
          currentBalancePaise: acc.balancePaise,
          attemptedDebitPaise: p.side === 'DEBIT' ? p.amountPaise : 0
        });
      }
    }

    // 4. Sequence & Journal Entry (Immutable)
    const seqRes = await client.query("SELECT nextval('ledger_journal_entries_sequence_seq') as next_seq");
    const nextSeq = Number(seqRes.rows[0].next_seq);
    const entryId = `JE-${String(nextSeq).padStart(10, '0')}`;
    const safeDescription = String(description || '').replace(/₹/g, 'INR ');

    await client.query(`
      INSERT INTO ledger_journal_entries (entry_id, sequence, reference_id, idempotency_key, description, total_paise, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW());
    `, [entryId, nextSeq, referenceId, idempotencyKey, safeDescription, totalDebits, JSON.stringify(metadata)]);

    // 5. Postings (Immutable)
    for (const p of normalized) {
      await client.query(`
        INSERT INTO ledger_postings (posting_id, entry_id, account_id, side, amount_paise, metadata, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW());
      `, [p.postingId, entryId, p.accountId, p.side, p.amountPaise, JSON.stringify(p.metadata)]);
    }

    // 6. Update Materialized Account Balances
    for (const [accId, delta] of accountDeltas.entries()) {
      await client.query(`
        UPDATE ledger_accounts
        SET balance_paise = $1,
            debit_paise = debit_paise + $2,
            credit_paise = credit_paise + $3,
            version = version + 1,
            updated_at = NOW()
        WHERE account_id = $4;
      `, [delta.balancePaise, delta.addDebitPaise, delta.addCreditPaise, accId]);
    }

    // 7. Payment Transaction Update (if provided)
    if (paymentRecord) {
      await client.query(`
        INSERT INTO payment_transactions (
          payment_id, trip_id, order_id, customer_id, driver_id, currency,
          amount_paise, escrow_paise, refunded_paise, commission_bps, commission_paise,
          gst_bps, gst_paise, driver_earnings_paise, state, dispute_id, adjustment_paise,
          version, transaction_id, metadata, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW()
        )
        ON CONFLICT (payment_id) DO UPDATE SET
          driver_id = EXCLUDED.driver_id,
          escrow_paise = EXCLUDED.escrow_paise,
          refunded_paise = EXCLUDED.refunded_paise,
          commission_paise = EXCLUDED.commission_paise,
          gst_paise = EXCLUDED.gst_paise,
          driver_earnings_paise = EXCLUDED.driver_earnings_paise,
          state = EXCLUDED.state,
          dispute_id = EXCLUDED.dispute_id,
          adjustment_paise = EXCLUDED.adjustment_paise,
          version = payment_transactions.version + 1,
          transaction_id = EXCLUDED.transaction_id,
          metadata = EXCLUDED.metadata,
          updated_at = NOW();
      `, [
        paymentRecord.paymentId,
        paymentRecord.tripId,
        paymentRecord.orderId || paymentRecord.tripId,
        paymentRecord.customerId,
        paymentRecord.driverId || null,
        paymentRecord.currency || 'INR',
        paymentRecord.amountPaise,
        paymentRecord.escrowPaise || 0,
        paymentRecord.refundedPaise || 0,
        paymentRecord.commissionBps || 1000,
        paymentRecord.commissionPaise || 0,
        paymentRecord.gstBps || 1800,
        paymentRecord.gstPaise || 0,
        paymentRecord.driverEarningsPaise || 0,
        paymentRecord.state,
        paymentRecord.disputeId || null,
        paymentRecord.adjustmentPaise || 0,
        paymentRecord.version || 1,
        entryId,
        JSON.stringify(paymentRecord.metadata || {})
      ]);
    }

    // 8. Transactional Outbox (Atomically Bound)
    if (outboxEvent) {
      let eventId = outboxEvent.eventId || `EVT_${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
      if (eventId.length > 64) {
        eventId = `EVT_${crypto.createHash('sha256').update(eventId).digest('hex').slice(0, 60)}`;
      }
      await client.query(`
        INSERT INTO payment_outbox (event_id, aggregate_type, aggregate_id, event_type, payload, created_at, status)
        VALUES ($1, $2, $3, $4, $5, NOW(), 'PENDING')
        ON CONFLICT (event_id) DO NOTHING;
      `, [
        eventId,
        outboxEvent.aggregateType || 'PAYMENT',
        outboxEvent.aggregateId || referenceId,
        outboxEvent.eventType,
        JSON.stringify(outboxEvent.payload || outboxEvent)
      ]);
    }

    return {
      entryId,
      referenceId,
      totalPaise: totalDebits,
      idempotentReplay: false
    };
  }

  /**
   * Post journal entry with full PostgreSQL ACID transactional durability,
   * advisory lock serialization, and outbox event persistence.
   */
  async postJournalEntry({
    referenceId,
    idempotencyKey,
    description,
    postings,
    metadata = {},
    outboxEvent = null,
    paymentRecord = null
  }) {
    if (!idempotencyKey) throw new LedgerError('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey is required.');
    if (!referenceId) throw new LedgerError('INVALID_REFERENCE', 'referenceId is required.');
    if (!Array.isArray(postings) || postings.length === 0) {
      throw new LedgerError('INVALID_POSTINGS', 'At least one posting is required.');
    }

    const requestHash = this._requestHash({ referenceId, description, postings, metadata });
    const client = await this.pool.pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Transaction-Scoped Advisory Locks (Serialization across cluster)
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idempotencyKey]);

      const pLockId = paymentRecord?.paymentId || metadata?.paymentId || (metadata?.tripId ? `PAY_${metadata.tripId}` : null);
      if (pLockId) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PAYMENT_${pLockId}`]);
      }

      // 2. Idempotency Check
      const idempRes = await client.query(
        'SELECT idempotency_key, request_hash, entry_id, response_payload FROM ledger_idempotency WHERE idempotency_key = $1 FOR UPDATE',
        [idempotencyKey]
      );

      if (idempRes.rows.length > 0) {
        const existing = idempRes.rows[0];
        if (existing.request_hash === requestHash) {
          await client.query('COMMIT');
          return {
            ...existing.response_payload,
            idempotentReplay: true
          };
        } else {
          await client.query('ROLLBACK');
          throw new LedgerError(
            'IDEMPOTENCY_KEY_REUSE',
            `Idempotency key ${idempotencyKey} has already been used with a different request payload.`,
            { idempotencyKey }
          );
        }
      }

      const result = await this._executePostingsWithinClient(client, {
        referenceId,
        idempotencyKey,
        description,
        postings,
        metadata,
        paymentRecord,
        outboxEvent
      });

      // 3. Record Idempotency Entry
      await client.query(`
        INSERT INTO ledger_idempotency (idempotency_key, request_hash, entry_id, response_payload, created_at)
        VALUES ($1, $2, $3, $4, NOW());
      `, [idempotencyKey, requestHash, result.entryId, JSON.stringify(result)]);

      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // DOMAIN FINANCIAL OPERATIONS (ACID POSTGRESQL ATOMICITY)
  // =========================================================================

  getCustomerAccountId(customerId) {
    return `customer:${customerId}:wallet`;
  }

  getDriverAccountId(driverId) {
    return `driver:${driverId}:earnings`;
  }

  async getCustomerBalance(customerId) {
    try {
      const acc = await this.getAccount(this.getCustomerAccountId(customerId));
      return { paise: acc.balancePaise, rupees: +(acc.balancePaise / 100).toFixed(2) };
    } catch (_) {
      return { paise: 0, rupees: 0 };
    }
  }

  async getDriverBalance(driverId) {
    try {
      const acc = await this.getAccount(this.getDriverAccountId(driverId));
      return { paise: acc.balancePaise, rupees: +(acc.balancePaise / 100).toFixed(2) };
    } catch (_) {
      return { paise: 0, rupees: 0 };
    }
  }

  async topUpCustomerWallet({ customerId, amountPaise, idempotencyKey, referenceId = null }) {
    if (!customerId) throw new LedgerError('INVALID_CUSTOMER', 'customerId is required.');
    const account = this.getCustomerAccountId(customerId);
    await this.ensureAccount(account, 'LIABILITY', 'CREDIT');

    const result = await this.postJournalEntry({
      referenceId: referenceId || `TOPUP_${customerId}_${Date.now()}`,
      idempotencyKey,
      description: `Customer wallet top-up INR ${+(amountPaise / 100).toFixed(2)}`,
      postings: [
        { accountId: 'cash:external', side: 'DEBIT', amountPaise },
        { accountId: account, side: 'CREDIT', amountPaise }
      ],
      metadata: { customerId, type: 'CUSTOMER_TOPUP' },
      outboxEvent: {
        eventId: `EVT_TOPUP_${idempotencyKey}`,
        aggregateType: 'CUSTOMER_WALLET',
        aggregateId: customerId,
        eventType: 'WalletTopUpCompleted',
        payload: { customerId, amountPaise }
      }
    });

    const custBalance = await this.getCustomerBalance(customerId);
    return {
      success: true,
      status: 'COMPLETED',
      transactionId: result.entryId,
      idempotentReplay: Boolean(result.idempotentReplay),
      amountPaise,
      customerBalance: custBalance
    };
  }

  async reserveEscrow({ tripId, orderId = null, customerId, amountPaise, idempotencyKey = null, expectedVersion = null }) {
    if (!tripId || !customerId || !amountPaise) {
      throw new LedgerError('INVALID_PARAMS', 'tripId, customerId, and amountPaise are required.');
    }
    const paymentId = `PAY_${tripId}`;
    const key = idempotencyKey || `VAAYU:${tripId}:ESCROW`;
    const customerAccount = this.getCustomerAccountId(customerId);

    await this.ensureAccount(customerAccount, 'LIABILITY', 'CREDIT');
    await this.ensureAccount('escrow:platform', 'LIABILITY', 'CREDIT');

    const client = await this.pool.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PAYMENT_${paymentId}`]);

      const idempRes = await client.query('SELECT response_payload FROM ledger_idempotency WHERE idempotency_key = $1 FOR UPDATE', [key]);
      if (idempRes.rows.length > 0) {
        await client.query('COMMIT');
        return { ...idempRes.rows[0].response_payload, idempotentReplay: true };
      }

      const txRes = await client.query('SELECT * FROM payment_transactions WHERE payment_id = $1 FOR UPDATE', [paymentId]);
      let existing = txRes.rows.length > 0 ? this._mapPayment(txRes.rows[0]) : null;

      if (existing && existing.state === 'ESCROWED') {
        if (amountPaise !== existing.escrowPaise) {
          await client.query('ROLLBACK');
          throw new LedgerError(
            'IDEMPOTENCY_PAYLOAD_MISMATCH',
            `Idempotency payload conflict: trip ${tripId} is already escrowed for ${existing.escrowPaise} paise, but requested ${amountPaise} paise.`,
            { tripId, escrowPaise: existing.escrowPaise, requestedPaise: amountPaise }
          );
        }
        await client.query('COMMIT');
        return {
          success: true,
          status: 'ESCROWED',
          tripId,
          paymentId,
          transactionId: existing.transactionId,
          idempotentReplay: true,
          amountPaise: existing.escrowPaise,
          customerBalance: await this.getCustomerBalance(customerId),
          version: existing.version
        };
      }

      if (existing && existing.state !== 'INITIATED') {
        await client.query('ROLLBACK');
        throw new LedgerError(
          'ILLEGAL_PAYMENT_TRANSITION',
          `Illegal payment transition from ${existing.state} to ESCROWED for trip ${tripId}`,
          { currentState: existing.state, attemptedState: 'ESCROWED', paymentId }
        );
      }

      if (expectedVersion !== null && existing && existing.version !== expectedVersion) {
        await client.query('ROLLBACK');
        throw new LedgerError(
          'VERSION_CONFLICT',
          `Optimistic lock failure: payment version ${existing.version} does not match expected version ${expectedVersion}`,
          { expectedVersion, actualVersion: existing.version, paymentId }
        );
      }

      const paymentRecord = {
        paymentId,
        tripId,
        orderId: orderId || tripId,
        customerId,
        amountPaise,
        escrowPaise: amountPaise,
        state: 'ESCROWED',
        version: existing ? existing.version + 1 : 1
      };

      const outboxEvent = {
        eventId: `EVT_${key}`,
        aggregateType: 'PAYMENT',
        aggregateId: paymentId,
        eventType: 'PaymentEscrowed',
        payload: { tripId, paymentId, amountPaise }
      };

      const ledgerResult = await this._executePostingsWithinClient(client, {
        referenceId: `TRIP_${tripId}_ESCROW`,
        idempotencyKey: key,
        description: `Escrow hold for trip ${tripId}`,
        postings: [
          { accountId: customerAccount, side: 'DEBIT', amountPaise },
          { accountId: 'escrow:platform', side: 'CREDIT', amountPaise }
        ],
        metadata: { tripId, customerId, paymentId, type: 'TRIP_ESCROW' },
        paymentRecord,
        outboxEvent
      });

      const response = {
        success: true,
        status: 'ESCROWED',
        tripId,
        paymentId,
        transactionId: ledgerResult.entryId,
        idempotentReplay: false,
        amountPaise,
        customerBalance: await this.getCustomerBalance(customerId),
        version: paymentRecord.version
      };

      const requestHash = this._requestHash({ referenceId: `TRIP_${tripId}_ESCROW`, idempotencyKey: key, amountPaise });
      await client.query(`
        INSERT INTO ledger_idempotency (idempotency_key, request_hash, entry_id, response_payload, created_at)
        VALUES ($1, $2, $3, $4, NOW());
      `, [key, requestHash, ledgerResult.entryId, JSON.stringify(response)]);

      await client.query('COMMIT');
      return response;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async settleTrip({ tripId, driverId, amountPaise = null, platformCommissionPaise = null, idempotencyKey = null, expectedVersion = null, commissionBps = 1000, gstBps = 1800 }) {
    if (!tripId || !driverId) throw new LedgerError('INVALID_PARAMS', 'tripId and driverId are required.');
    const paymentId = `PAY_${tripId}`;
    const key = idempotencyKey || `VAAYU:${tripId}:SETTLE`;

    const client = await this.pool.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PAYMENT_${paymentId}`]);

      const idempRes = await client.query('SELECT response_payload FROM ledger_idempotency WHERE idempotency_key = $1 FOR UPDATE', [key]);
      if (idempRes.rows.length > 0) {
        await client.query('COMMIT');
        return { ...idempRes.rows[0].response_payload, idempotentReplay: true };
      }

      const txRes = await client.query('SELECT * FROM payment_transactions WHERE payment_id = $1 FOR UPDATE', [paymentId]);
      if (txRes.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new LedgerError('PAYMENT_NOT_FOUND', `No payment transaction exists for trip ${tripId}`);
      }
      const tx = this._mapPayment(txRes.rows[0]);

      if (tx.state === 'SETTLED') {
        // If state is already settled and key was NOT in idempotency table -> illegal transition / double settlement
        await client.query('ROLLBACK');
        throw new LedgerError('ILLEGAL_PAYMENT_TRANSITION', `Payment ${paymentId} is already SETTLED. Double settlement rejected.`, {
          currentState: 'SETTLED',
          attemptedState: 'SETTLED',
          paymentId
        });
      }

      if (tx.state !== 'ESCROWED') {
        await client.query('ROLLBACK');
        throw new LedgerError(
          'ILLEGAL_PAYMENT_TRANSITION',
          `Illegal payment transition: ${tx.state} -> SETTLED for trip ${tripId}`,
          { currentState: tx.state, attemptedState: 'SETTLED', paymentId }
        );
      }

      if (expectedVersion !== null && tx.version !== expectedVersion) {
        await client.query('ROLLBACK');
        throw new LedgerError(
          'VERSION_CONFLICT',
          `Optimistic lock failure: version ${tx.version} does not match expected version ${expectedVersion}`,
          { expectedVersion, actualVersion: tx.version, paymentId }
        );
      }

      const settleAmountPaise = amountPaise ?? tx.escrowPaise;
      const effCommissionBps = tx.commissionBps || commissionBps;
      const effGstBps = tx.gstBps || gstBps;

      let commissionAmountPaise;
      let gstAmountPaise;
      let driverEarningsPaise;

      if (platformCommissionPaise !== null && platformCommissionPaise !== undefined) {
        commissionAmountPaise = platformCommissionPaise;
        gstAmountPaise = Math.floor((commissionAmountPaise * effGstBps) / 10000);
        driverEarningsPaise = settleAmountPaise - commissionAmountPaise - gstAmountPaise;
      } else {
        commissionAmountPaise = Math.floor((settleAmountPaise * effCommissionBps) / 10000);
        gstAmountPaise = Math.floor((commissionAmountPaise * effGstBps) / 10000);
        driverEarningsPaise = settleAmountPaise - commissionAmountPaise - gstAmountPaise;
      }

      const driverAccount = this.getDriverAccountId(driverId);
      await this.ensureAccount(driverAccount, 'LIABILITY', 'CREDIT');
      await this.ensureAccount('platform:commission', 'REVENUE', 'CREDIT');
      await this.ensureAccount('platform:gst', 'LIABILITY', 'CREDIT');

      const paymentRecord = {
        paymentId,
        tripId,
        orderId: tx.orderId,
        customerId: tx.customerId,
        driverId,
        amountPaise: tx.amountPaise,
        escrowPaise: 0,
        commissionBps: effCommissionBps,
        commissionPaise: commissionAmountPaise,
        gstBps: effGstBps,
        gstPaise: gstAmountPaise,
        driverEarningsPaise,
        state: 'SETTLED',
        version: tx.version + 1
      };

      const outboxEvent = {
        eventId: `EVT_${key}`,
        aggregateType: 'PAYMENT',
        aggregateId: paymentId,
        eventType: 'PaymentSettled',
        payload: { tripId, paymentId, driverId, driverEarningsPaise, commissionPaise: commissionAmountPaise, gstPaise: gstAmountPaise }
      };

      const ledgerResult = await this._executePostingsWithinClient(client, {
        referenceId: `TRIP_${tripId}_SETTLEMENT`,
        idempotencyKey: key,
        description: `Settlement for trip ${tripId} to driver ${driverId}`,
        postings: [
          { accountId: 'escrow:platform', side: 'DEBIT', amountPaise: settleAmountPaise },
          { accountId: driverAccount, side: 'CREDIT', amountPaise: driverEarningsPaise },
          { accountId: 'platform:commission', side: 'CREDIT', amountPaise: commissionAmountPaise },
          { accountId: 'platform:gst', side: 'CREDIT', amountPaise: gstAmountPaise }
        ],
        metadata: { tripId, driverId, paymentId, type: 'TRIP_SETTLEMENT' },
        paymentRecord,
        outboxEvent
      });

      const response = {
        success: true,
        status: 'SETTLED',
        tripId,
        paymentId,
        transactionId: ledgerResult.entryId,
        idempotentReplay: false,
        totalFarePaise: tx.amountPaise,
        driverEarningsPaise,
        commissionPaise: commissionAmountPaise,
        gstPaise: gstAmountPaise,
        driverBalance: await this.getDriverBalance(driverId),
        version: paymentRecord.version
      };

      const requestHash = this._requestHash({ referenceId: `TRIP_${tripId}_SETTLEMENT`, idempotencyKey: key, amountPaise });
      await client.query(`
        INSERT INTO ledger_idempotency (idempotency_key, request_hash, entry_id, response_payload, created_at)
        VALUES ($1, $2, $3, $4, NOW());
      `, [key, requestHash, ledgerResult.entryId, JSON.stringify(response)]);

      await client.query('COMMIT');
      return response;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async refundTrip({ tripId, paymentId = null, amountPaise = null, reason = 'Trip refund', idempotencyKey = null, expectedVersion = null }) {
    const effPaymentId = paymentId || `PAY_${tripId}`;
    const key = idempotencyKey || `VAAYU:${tripId}:REFUND`;
    const client = await this.pool.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PAYMENT_${effPaymentId}`]);

      const idempRes = await client.query('SELECT response_payload FROM ledger_idempotency WHERE idempotency_key = $1 FOR UPDATE', [key]);
      if (idempRes.rows.length > 0) {
        await client.query('COMMIT');
        return { ...idempRes.rows[0].response_payload, idempotentReplay: true };
      }

      const txRes = await client.query('SELECT * FROM payment_transactions WHERE payment_id = $1 FOR UPDATE', [effPaymentId]);
      if (txRes.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new LedgerError('PAYMENT_NOT_FOUND', `No payment transaction exists for ${effPaymentId}`);
      }
      const tx = this._mapPayment(txRes.rows[0]);

      if (tx.state === 'REFUNDED') {
        await client.query('ROLLBACK');
        throw new LedgerError('REFUND_LIMIT_EXCEEDED', `Trip ${tx.tripId} escrow is already fully refunded.`);
      }

      if (tx.state !== 'ESCROWED') {
        await client.query('ROLLBACK');
        throw new LedgerError(
          'ILLEGAL_PAYMENT_TRANSITION',
          `Illegal payment transition: ${tx.state} -> REFUNDED for payment ${effPaymentId}`,
          { currentState: tx.state, attemptedState: 'REFUNDED', paymentId: effPaymentId }
        );
      }

      const refundAmount = amountPaise ?? tx.escrowPaise;
      if (refundAmount > tx.escrowPaise) {
        await client.query('ROLLBACK');
        throw new LedgerError(
          'REFUND_LIMIT_EXCEEDED',
          `Refund amount ${refundAmount} paise exceeds remaining escrow ${tx.escrowPaise} paise.`,
          { requestedPaise: refundAmount, remainingEscrowPaise: tx.escrowPaise }
        );
      }

      const remainingEscrow = tx.escrowPaise - refundAmount;
      const isPartial = remainingEscrow > 0;
      const nextState = isPartial ? 'ESCROWED' : 'REFUNDED';
      const customerAccount = this.getCustomerAccountId(tx.customerId);

      const paymentRecord = {
        ...tx,
        escrowPaise: remainingEscrow,
        refundedPaise: (tx.refundedPaise || 0) + refundAmount,
        state: nextState,
        version: tx.version + 1
      };

      const outboxEvent = {
        eventId: `EVT_${key}`,
        aggregateType: 'PAYMENT',
        aggregateId: tx.paymentId,
        eventType: isPartial ? 'PaymentPartiallyRefunded' : 'PaymentRefunded',
        payload: { tripId: tx.tripId, paymentId: tx.paymentId, refundAmount, remainingEscrow }
      };

      const ledgerResult = await this._executePostingsWithinClient(client, {
        referenceId: `TRIP_${tx.tripId}_REFUND`,
        idempotencyKey: key,
        description: `Refund for trip ${tx.tripId}: ${reason}`,
        postings: [
          { accountId: 'escrow:platform', side: 'DEBIT', amountPaise: refundAmount },
          { accountId: customerAccount, side: 'CREDIT', amountPaise: refundAmount }
        ],
        metadata: { tripId: tx.tripId, paymentId: tx.paymentId, isPartial, type: 'TRIP_REFUND' },
        paymentRecord,
        outboxEvent
      });

      const response = {
        success: true,
        status: nextState,
        tripId: tx.tripId,
        paymentId: tx.paymentId,
        transactionId: ledgerResult.entryId,
        idempotentReplay: false,
        refundedPaise: refundAmount,
        remainingEscrowPaise: remainingEscrow,
        isPartial,
        customerBalance: await this.getCustomerBalance(tx.customerId),
        version: paymentRecord.version
      };

      const requestHash = this._requestHash({ referenceId: `TRIP_${tx.tripId}_REFUND`, idempotencyKey: key, refundAmount });
      await client.query(`
        INSERT INTO ledger_idempotency (idempotency_key, request_hash, entry_id, response_payload, created_at)
        VALUES ($1, $2, $3, $4, NOW());
      `, [key, requestHash, ledgerResult.entryId, JSON.stringify(response)]);

      await client.query('COMMIT');
      return response;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async expirePayment({ tripId, paymentId = null, reason = 'Escrow expired', idempotencyKey = null, expectedVersion = null }) {
    const effPaymentId = paymentId || `PAY_${tripId}`;
    const key = idempotencyKey || `VAAYU:${tripId}:EXPIRE`;
    const client = await this.pool.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PAYMENT_${effPaymentId}`]);

      const idempRes = await client.query('SELECT response_payload FROM ledger_idempotency WHERE idempotency_key = $1 FOR UPDATE', [key]);
      if (idempRes.rows.length > 0) {
        await client.query('COMMIT');
        return { ...idempRes.rows[0].response_payload, idempotentReplay: true };
      }

      const txRes = await client.query('SELECT * FROM payment_transactions WHERE payment_id = $1 FOR UPDATE', [effPaymentId]);
      if (txRes.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new LedgerError('PAYMENT_NOT_FOUND', `No payment transaction exists for ${effPaymentId}`);
      }
      const tx = this._mapPayment(txRes.rows[0]);

      if (tx.state === 'EXPIRED') {
        await client.query('COMMIT');
        return {
          success: true,
          status: 'EXPIRED',
          tripId: tx.tripId,
          paymentId: tx.paymentId,
          transactionId: tx.transactionId,
          idempotentReplay: true,
          releasedPaise: tx.amountPaise,
          version: tx.version
        };
      }

      if (tx.state !== 'ESCROWED') {
        await client.query('ROLLBACK');
        throw new LedgerError(
          'ILLEGAL_PAYMENT_TRANSITION',
          `Illegal payment transition: ${tx.state} -> EXPIRED for payment ${effPaymentId}`,
          { currentState: tx.state, attemptedState: 'EXPIRED', paymentId: effPaymentId }
        );
      }

      const releaseAmount = tx.escrowPaise;
      const customerAccount = this.getCustomerAccountId(tx.customerId);

      const paymentRecord = {
        ...tx,
        escrowPaise: 0,
        state: 'EXPIRED',
        version: tx.version + 1
      };

      const outboxEvent = {
        eventId: `EVT_${key}`,
        aggregateType: 'PAYMENT',
        aggregateId: tx.paymentId,
        eventType: 'PaymentExpired',
        payload: { tripId: tx.tripId, paymentId: tx.paymentId, releasedPaise: releaseAmount, reason }
      };

      const ledgerResult = await this._executePostingsWithinClient(client, {
        referenceId: `TRIP_${tx.tripId}_EXPIRE`,
        idempotencyKey: key,
        description: `Released expired escrow for trip ${tx.tripId}: ${reason}`,
        postings: [
          { accountId: 'escrow:platform', side: 'DEBIT', amountPaise: releaseAmount },
          { accountId: customerAccount, side: 'CREDIT', amountPaise: releaseAmount }
        ],
        metadata: { tripId: tx.tripId, paymentId: tx.paymentId, type: 'ESCROW_EXPIRY' },
        paymentRecord,
        outboxEvent
      });

      const response = {
        success: true,
        status: 'EXPIRED',
        tripId: tx.tripId,
        paymentId: tx.paymentId,
        transactionId: ledgerResult.entryId,
        idempotentReplay: false,
        releasedPaise: releaseAmount,
        customerBalance: await this.getCustomerBalance(tx.customerId),
        version: paymentRecord.version
      };

      const requestHash = this._requestHash({ referenceId: `TRIP_${tx.tripId}_EXPIRE`, idempotencyKey: key });
      await client.query(`
        INSERT INTO ledger_idempotency (idempotency_key, request_hash, entry_id, response_payload, created_at)
        VALUES ($1, $2, $3, $4, NOW());
      `, [key, requestHash, ledgerResult.entryId, JSON.stringify(response)]);

      await client.query('COMMIT');
      return response;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async disputePayment({ tripId, paymentId = null, disputeId, reason = 'Customer complaint', idempotencyKey = null, expectedVersion = null }) {
    const effPaymentId = paymentId || `PAY_${tripId}`;
    const tx = await this.getPayment(effPaymentId);
    if (!tx) throw new LedgerError('PAYMENT_NOT_FOUND', `No payment transaction exists for ${effPaymentId}`);

    if (tx.state === 'DISPUTED') {
      return {
        success: true,
        status: 'DISPUTED',
        tripId: tx.tripId,
        paymentId: tx.paymentId,
        disputeId: tx.disputeId || disputeId,
        idempotentReplay: true,
        version: tx.version
      };
    }

    if (tx.state !== 'SETTLED') {
      throw new LedgerError(
        'ILLEGAL_PAYMENT_TRANSITION',
        `Illegal payment transition: ${tx.state} -> DISPUTED for payment ${effPaymentId}`,
        { currentState: tx.state, attemptedState: 'DISPUTED', paymentId: effPaymentId }
      );
    }

    const key = idempotencyKey || `VAAYU:${tx.tripId}:DISPUTE:${disputeId}`;
    const paymentRecord = {
      ...tx,
      state: 'DISPUTED',
      disputeId,
      version: tx.version + 1
    };

    await this.pool.query(`
      UPDATE payment_transactions
      SET state = 'DISPUTED',
          dispute_id = $1,
          version = version + 1,
          updated_at = NOW()
      WHERE payment_id = $2;
    `, [disputeId, effPaymentId]);

    const outboxEvent = {
      eventId: `EVT_${key}`,
      aggregateType: 'PAYMENT',
      aggregateId: tx.paymentId,
      eventType: 'PaymentDisputed',
      payload: { tripId: tx.tripId, paymentId: tx.paymentId, disputeId, reason }
    };

    await this.pool.query(`
      INSERT INTO payment_outbox (event_id, aggregate_type, aggregate_id, event_type, payload, created_at, status)
      VALUES ($1, $2, $3, $4, $5, NOW(), 'PENDING')
      ON CONFLICT (event_id) DO NOTHING;
    `, [
      outboxEvent.eventId,
      outboxEvent.aggregateType,
      outboxEvent.aggregateId,
      outboxEvent.eventType,
      JSON.stringify(outboxEvent.payload)
    ]);

    return {
      success: true,
      status: 'DISPUTED',
      tripId: tx.tripId,
      paymentId: tx.paymentId,
      disputeId,
      idempotentReplay: false,
      version: paymentRecord.version
    };
  }

  async adjustPayment({ tripId, paymentId = null, disputeId, adjustmentPaise = null, allocations, reason = 'Dispute resolution', idempotencyKey = null, expectedVersion = null }) {
    const effPaymentId = paymentId || `PAY_${tripId}`;
    const tx = await this.getPayment(effPaymentId);
    if (!tx) throw new LedgerError('PAYMENT_NOT_FOUND', `No payment transaction exists for ${effPaymentId}`);

    if (tx.state === 'ADJUSTED') {
      return {
        success: true,
        status: 'ADJUSTED',
        tripId: tx.tripId,
        paymentId: tx.paymentId,
        disputeId: tx.disputeId || disputeId,
        idempotentReplay: true,
        adjustmentPaise: tx.adjustmentPaise,
        allocations,
        version: tx.version
      };
    }

    if (tx.state !== 'DISPUTED') {
      throw new LedgerError(
        'ILLEGAL_PAYMENT_TRANSITION',
        `Illegal payment transition: ${tx.state} -> ADJUSTED for payment ${effPaymentId}`,
        { currentState: tx.state, attemptedState: 'ADJUSTED', paymentId: effPaymentId }
      );
    }

    const customerCredit = Number(allocations.customerCreditPaise || 0);
    const driverDebit = Number(allocations.driverDebitPaise || 0);
    const platformDebit = Number(allocations.platformDebitPaise || 0);
    const taxAdjustment = Number(allocations.taxAdjustmentPaise || 0);

    if (customerCredit !== (driverDebit + platformDebit + taxAdjustment)) {
      throw new LedgerError(
        'INVALID_ADJUSTMENT_ALLOCATION',
        `Adjustment debits (${driverDebit + platformDebit + taxAdjustment}) must equal customer credit (${customerCredit}).`
      );
    }

    const key = idempotencyKey || `VAAYU:${tx.tripId}:ADJUST:${disputeId}`;
    const customerAccount = this.getCustomerAccountId(tx.customerId);
    const driverAccount = this.getDriverAccountId(tx.driverId);

    const postings = [{ accountId: customerAccount, side: 'CREDIT', amountPaise: customerCredit }];
    if (driverDebit > 0) postings.push({ accountId: driverAccount, side: 'DEBIT', amountPaise: driverDebit });
    if (platformDebit > 0) postings.push({ accountId: 'platform:commission', side: 'DEBIT', amountPaise: platformDebit });
    if (taxAdjustment > 0) postings.push({ accountId: 'platform:gst', side: 'DEBIT', amountPaise: taxAdjustment });

    const paymentRecord = {
      ...tx,
      adjustmentPaise: customerCredit,
      state: 'ADJUSTED',
      version: tx.version + 1
    };

    const outboxEvent = {
      eventId: `EVT_${key}`,
      aggregateType: 'PAYMENT',
      aggregateId: tx.paymentId,
      eventType: 'PaymentAdjusted',
      payload: { tripId: tx.tripId, paymentId: tx.paymentId, disputeId, adjustmentPaise: customerCredit, allocations, reason }
    };

    const ledgerResult = await this.postJournalEntry({
      referenceId: `TRIP_${tx.tripId}_ADJUST`,
      idempotencyKey: key,
      description: `Dispute adjustment for trip ${tx.tripId}: ${reason}`,
      postings,
      metadata: { tripId: tx.tripId, paymentId: tx.paymentId, disputeId, type: 'TRIP_ADJUSTMENT' },
      paymentRecord,
      outboxEvent
    });

    return {
      success: true,
      status: 'ADJUSTED',
      tripId: tx.tripId,
      paymentId: tx.paymentId,
      disputeId,
      transactionId: ledgerResult.entryId,
      idempotentReplay: Boolean(ledgerResult.idempotentReplay),
      adjustmentPaise: customerCredit,
      allocations,
      version: paymentRecord.version
    };
  }

  async payoutDriver({ driverId, amountPaise, payoutId = null, idempotencyKey = null }) {
    if (!driverId || !amountPaise) throw new LedgerError('INVALID_PARAMS', 'driverId and amountPaise are required.');
    const effPayoutId = payoutId || `PO_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const key = idempotencyKey || `PAYOUT_${driverId}_${effPayoutId}`;
    const driverAccount = this.getDriverAccountId(driverId);

    await this.ensureAccount(driverAccount, 'LIABILITY', 'CREDIT');
    await this.ensureAccount('payout:clearing', 'LIABILITY', 'CREDIT');

    const result = await this.postJournalEntry({
      referenceId: `PAYOUT_${effPayoutId}`,
      idempotencyKey: key,
      description: `Driver earnings payout ${effPayoutId}`,
      postings: [
        { accountId: driverAccount, side: 'DEBIT', amountPaise },
        { accountId: 'payout:clearing', side: 'CREDIT', amountPaise }
      ],
      metadata: { driverId, payoutId: effPayoutId, type: 'DRIVER_PAYOUT' },
      outboxEvent: {
        eventId: `EVT_${key}`,
        aggregateType: 'PAYOUT',
        aggregateId: effPayoutId,
        eventType: 'DriverPayoutInitiated',
        payload: { driverId, payoutId: effPayoutId, amountPaise }
      }
    });

    const driverBal = await this.getDriverBalance(driverId);
    return {
      success: true,
      status: 'PENDING_CLEARING',
      payoutId: effPayoutId,
      transactionId: result.entryId,
      idempotentReplay: Boolean(result.idempotentReplay),
      amountPaise,
      driverBalance: driverBal
    };
  }

  async settlePayout({ payoutId, amountPaise, idempotencyKey = null }) {
    if (!payoutId || !amountPaise) throw new LedgerError('INVALID_PARAMS', 'payoutId and amountPaise are required.');
    const key = idempotencyKey || `DISBURSE_${payoutId}`;

    await this.ensureAccount('payout:clearing', 'LIABILITY', 'CREDIT');
    await this.ensureAccount('cash:external', 'ASSET', 'DEBIT');

    const result = await this.postJournalEntry({
      referenceId: `DISBURSE_${payoutId}`,
      idempotencyKey: key,
      description: `Disbursed payout ${payoutId} via banking rail`,
      postings: [
        { accountId: 'payout:clearing', side: 'DEBIT', amountPaise },
        { accountId: 'cash:external', side: 'CREDIT', amountPaise }
      ],
      metadata: { payoutId, type: 'PAYOUT_DISBURSED' },
      outboxEvent: {
        eventId: `EVT_${key}`,
        aggregateType: 'PAYOUT',
        aggregateId: payoutId,
        eventType: 'DriverPayoutDisbursed',
        payload: { payoutId, amountPaise }
      }
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

  /**
   * Authoritative Reconciliation Engine
   * Validates sum of immutable postings against materialized balances and double-entry parity
   */
  async reconcile() {
    const problems = [];

    // 1. Double-Entry Parity: Every journal entry debits === credits
    const unbalancedRes = await this.pool.query(`
      SELECT e.entry_id,
             SUM(CASE WHEN p.side = 'DEBIT' THEN p.amount_paise ELSE 0 END) as debits,
             SUM(CASE WHEN p.side = 'CREDIT' THEN p.amount_paise ELSE 0 END) as credits
      FROM ledger_journal_entries e
      JOIN ledger_postings p ON e.entry_id = p.entry_id
      GROUP BY e.entry_id
      HAVING SUM(CASE WHEN p.side = 'DEBIT' THEN p.amount_paise ELSE 0 END) !=
             SUM(CASE WHEN p.side = 'CREDIT' THEN p.amount_paise ELSE 0 END);
    `);

    for (const row of unbalancedRes.rows) {
      problems.push(`Unbalanced journal ${row.entry_id}: debits=${row.debits}, credits=${row.credits}`);
    }

    // 2. Materialized Balance Verification against Immutable Postings
    const balanceAuditRes = await this.pool.query(`
      WITH posting_totals AS (
        SELECT account_id,
               COALESCE(SUM(CASE WHEN side = 'DEBIT' THEN amount_paise ELSE 0 END), 0) as total_debits,
               COALESCE(SUM(CASE WHEN side = 'CREDIT' THEN amount_paise ELSE 0 END), 0) as total_credits
        FROM ledger_postings
        GROUP BY account_id
      )
      SELECT a.account_id,
             a.normal_balance,
             a.balance_paise,
             a.debit_paise,
             a.credit_paise,
             COALESCE(pt.total_debits, 0) as computed_debits,
             COALESCE(pt.total_credits, 0) as computed_credits
      FROM ledger_accounts a
      LEFT JOIN posting_totals pt ON a.account_id = pt.account_id;
    `);

    for (const row of balanceAuditRes.rows) {
      const balancePaise = Number(row.balance_paise);
      const computedDebits = Number(row.computed_debits);
      const computedCredits = Number(row.computed_credits);
      const debitPaise = Number(row.debit_paise);
      const creditPaise = Number(row.credit_paise);

      const expectedBalance = row.normal_balance === 'DEBIT'
        ? computedDebits - computedCredits
        : computedCredits - computedDebits;

      if (balancePaise !== expectedBalance) {
        problems.push(`Balance mismatch on ${row.account_id}: materialized=${balancePaise}, computed=${expectedBalance}`);
      }
      if (debitPaise !== computedDebits || creditPaise !== computedCredits) {
        problems.push(`Posting aggregate mismatch on ${row.account_id}`);
      }
    }

    const countRes = await this.pool.query('SELECT COUNT(*) as count FROM ledger_journal_entries');
    const journalEntries = parseInt(countRes.rows[0].count, 10);

    return {
      ok: problems.length === 0,
      problems,
      journalEntries
    };
  }

  /**
   * Detailed financial audit report
   */
  async getLedgerAudit(commissionBps = 1000, gstBps = 1800) {
    const accsRes = await this.pool.query('SELECT * FROM ledger_accounts');
    const accounts = {};
    for (const r of accsRes.rows) {
      accounts[r.account_id] = this._mapAccount(r);
    }

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

    let totalAssetsPaise = 0;
    let totalLiabilitiesPaise = 0;
    let totalEquityRevenuePaise = 0;

    for (const [id, acc] of Object.entries(accounts)) {
      if (id.startsWith('customer:') && id.endsWith(':wallet')) {
        customerWalletsCount++;
        customerWalletsBalancePaise += acc.balancePaise;
      } else if (id.startsWith('driver:') && id.endsWith(':earnings')) {
        driverEarningsCount++;
        driverEarningsBalancePaise += acc.balancePaise;
      }

      if (acc.accountType === 'ASSET') {
        totalAssetsPaise += acc.balancePaise;
      } else if (acc.accountType === 'LIABILITY') {
        totalLiabilitiesPaise += acc.balancePaise;
      } else if (acc.accountType === 'REVENUE') {
        totalEquityRevenuePaise += acc.balancePaise;
      }
    }

    const totalsRes = await this.pool.query(`
      SELECT COALESCE(SUM(CASE WHEN side = 'DEBIT' THEN amount_paise ELSE 0 END), 0) as total_debits,
             COALESCE(SUM(CASE WHEN side = 'CREDIT' THEN amount_paise ELSE 0 END), 0) as total_credits
      FROM ledger_postings;
    `);

    const totalDebitsPaise = Number(totalsRes.rows[0].total_debits);
    const totalCreditsPaise = Number(totalsRes.rows[0].total_credits);

    const expectedGstPaise = Math.floor((platformCommission.balancePaise * gstBps) / 10000);

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
        configuredGstBps: gstBps,
        expectedGstPaise,
        ratioCompliant: (platformGst.balancePaise === expectedGstPaise)
      },
      timestamp: new Date().toISOString()
    };
  }

  async getPayment(paymentId) {
    const res = await this.pool.query('SELECT * FROM payment_transactions WHERE payment_id = $1', [paymentId]);
    if (res.rows.length === 0) return null;
    return this._mapPayment(res.rows[0]);
  }

  async getPaymentByTripId(tripId) {
    const res = await this.pool.query('SELECT * FROM payment_transactions WHERE trip_id = $1', [tripId]);
    if (res.rows.length === 0) return null;
    return this._mapPayment(res.rows[0]);
  }

  _mapPayment(row) {
    return {
      paymentId: row.payment_id,
      tripId: row.trip_id,
      orderId: row.order_id,
      customerId: row.customer_id,
      driverId: row.driver_id,
      currency: row.currency,
      amountPaise: Number(row.amount_paise),
      escrowPaise: Number(row.escrow_paise),
      refundedPaise: Number(row.refunded_paise),
      commissionBps: row.commission_bps,
      commissionPaise: Number(row.commission_paise),
      gstBps: row.gst_bps,
      gstPaise: Number(row.gst_paise),
      driverEarningsPaise: Number(row.driver_earnings_paise),
      state: row.state,
      disputeId: row.dispute_id,
      adjustmentPaise: Number(row.adjustment_paise),
      version: row.version,
      transactionId: row.transaction_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: row.metadata || {}
    };
  }

  /**
   * In-memory snapshot replica for complete backward-compatibility
   */
  async snapshot() {
    const accountsRes = await this.pool.query('SELECT * FROM ledger_accounts');
    const entriesRes = await this.pool.query('SELECT * FROM ledger_journal_entries ORDER BY sequence ASC');
    const postingsRes = await this.pool.query('SELECT * FROM ledger_postings ORDER BY created_at ASC');
    const idempRes = await this.pool.query('SELECT * FROM ledger_idempotency');

    const accounts = {};
    for (const r of accountsRes.rows) {
      accounts[r.account_id] = this._mapAccount(r);
    }

    const postingsByEntry = new Map();
    for (const p of postingsRes.rows) {
      if (!postingsByEntry.has(p.entry_id)) postingsByEntry.set(p.entry_id, []);
      postingsByEntry.get(p.entry_id).push({
        postingId: p.posting_id,
        accountId: p.account_id,
        side: p.side,
        amountPaise: Number(p.amount_paise),
        metadata: p.metadata || {}
      });
    }

    const journalEntries = entriesRes.rows.map(e => ({
      entryId: e.entry_id,
      sequence: Number(e.sequence),
      referenceId: e.reference_id,
      idempotencyKey: e.idempotency_key,
      description: e.description,
      totalPaise: Number(e.total_paise),
      postings: postingsByEntry.get(e.entry_id) || [],
      metadata: e.metadata || {},
      createdAt: e.created_at
    }));

    const idempotency = {};
    for (const id of idempRes.rows) {
      idempotency[id.idempotency_key] = {
        requestHash: id.request_hash,
        result: id.response_payload
      };
    }

    return {
      schemaVersion: 1,
      sequence: journalEntries.length,
      accounts,
      journalEntries,
      idempotency
    };
  }
}

module.exports = {
  PostgresLedgerRepository
};
