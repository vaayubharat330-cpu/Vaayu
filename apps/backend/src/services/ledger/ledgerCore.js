const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * VAAYU DOUBLE-ENTRY LEDGER CORE v0.1
 * 
 * Invariants:
 * 1. Integer paise accounting only (1 INR = 100 paise).
 * 2. Strict double-entry: sum(debits) === sum(credits) for every entry.
 * 3. Immutable journal entries.
 * 4. Deterministic multi-account mutex locking to prevent race conditions & deadlocks.
 * 5. Idempotency protection with payload conflict detection.
 * 6. Materialized balances derived from ledger postings.
 */

// Account Normal Balances
const ACCOUNT_TYPES = {
  ASSET: 'ASSET',         // Normal balance: DEBIT (Balance = Debits - Credits)
  LIABILITY: 'LIABILITY', // Normal balance: CREDIT (Balance = Credits - Debits)
  REVENUE: 'REVENUE',     // Normal balance: CREDIT (Balance = Credits - Debits)
  EXPENSE: 'EXPENSE'      // Normal balance: DEBIT (Balance = Debits - Credits)
};

class Mutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  acquire() {
    return new Promise(resolve => {
      if (!this._locked) {
        this._locked = true;
        return resolve();
      }
      this._queue.push(resolve);
    });
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }
}

class LedgerCore {
  constructor(options = {}) {
    this.storagePath = options.storagePath || null;
    this.entries = [];
    this.idempotencyStore = new Map();
    this.materializedBalances = new Map(); // accountId -> balance in paise
    this.accountLocks = new Map(); // accountId -> Mutex
    this.globalMutex = new Mutex();
    this.load();
  }

  getAccountType(accountId) {
    if (accountId.startsWith('cash:')) return ACCOUNT_TYPES.ASSET;
    if (accountId.startsWith('platform:commission')) return ACCOUNT_TYPES.REVENUE;
    if (accountId.startsWith('customer:') || accountId.startsWith('escrow:') || 
        accountId.startsWith('driver:') || accountId.startsWith('payout:')) {
      return ACCOUNT_TYPES.LIABILITY;
    }
    return ACCOUNT_TYPES.LIABILITY;
  }

  isCreditNormal(accountType) {
    return accountType === ACCOUNT_TYPES.LIABILITY || accountType === ACCOUNT_TYPES.REVENUE;
  }

  getLock(accountId) {
    if (!this.accountLocks.has(accountId)) {
      this.accountLocks.set(accountId, new Mutex());
    }
    return this.accountLocks.get(accountId);
  }

  /**
   * Acquire locks deterministically in lexicographical order to prevent deadlocks
   */
  async acquireLocks(accountIds) {
    const uniqueSorted = [...new Set(accountIds)].sort();
    for (const accId of uniqueSorted) {
      await this.getLock(accId).acquire();
    }
    return uniqueSorted;
  }

  releaseLocks(sortedAccountIds) {
    // Release in reverse order
    for (const accId of [...sortedAccountIds].reverse()) {
      this.getLock(accId).release();
    }
  }

  getBalance(accountId) {
    return this.materializedBalances.get(accountId) || 0;
  }

  load() {
    if (!this.storagePath) return;
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(raw);
        this.entries = data.entries || [];
        this.rebuildMaterializedBalances();
      }
    } catch (e) {
      console.warn('[LedgerCore] Failed to load ledger storage file:', e.message);
    }
  }

  save() {
    if (!this.storagePath) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`;
      const payload = JSON.stringify({ entries: this.entries }, null, 2);
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.storagePath);
    } catch (e) {
      console.error('[LedgerCore] Failed to persist ledger:', e.message);
    }
  }

  rebuildMaterializedBalances() {
    this.materializedBalances.clear();
    for (const entry of this.entries) {
      for (const posting of entry.postings) {
        const current = this.materializedBalances.get(posting.accountId) || 0;
        const type = this.getAccountType(posting.accountId);
        const isCredit = this.isCreditNormal(type);
        
        let delta = 0;
        if (isCredit) {
          delta = posting.direction === 'CREDIT' ? posting.amount : -posting.amount;
        } else {
          delta = posting.direction === 'DEBIT' ? posting.amount : -posting.amount;
        }
        this.materializedBalances.set(posting.accountId, current + delta);
      }
    }
  }

  /**
   * Post a double-entry Journal Entry atomically.
   * 
   * @param {Object} params
   * @param {string} params.type Transaction type (e.g. 'TOP_UP', 'TRIP_ESCROW')
   * @param {string} params.referenceId External ID (e.g. tripId, payoutId)
   * @param {string} params.idempotencyKey Client-provided idempotency key
   * @param {string} [params.description]
   * @param {Array<{ accountId: string, direction: 'DEBIT'|'CREDIT', amount: number }>} params.postings
   */
  async postEntry({ type, referenceId, idempotencyKey, description = '', postings }) {
    if (!idempotencyKey) {
      throw new Error('[LedgerCore] idempotencyKey is required for every ledger transaction');
    }

    // Fast Idempotency Check
    if (this.idempotencyStore.has(idempotencyKey)) {
      const cached = this.idempotencyStore.get(idempotencyKey);
      // Validate payload hash to detect conflict
      const currentPayloadHash = crypto.createHash('sha256').update(JSON.stringify({ type, referenceId, postings })).digest('hex');
      if (cached.payloadHash !== currentPayloadHash) {
        const conflictErr = new Error(`[LedgerCore] Idempotency conflict for key ${idempotencyKey}: payload mismatch`);
        conflictErr.code = 'IDEMPOTENCY_CONFLICT';
        throw conflictErr;
      }
      return cached.result;
    }

    if (!Array.isArray(postings) || postings.length < 2) {
      throw new Error('[LedgerCore] A double-entry transaction must have at least 2 postings');
    }

    // Invariant 1: Integer paise only and positive amounts
    let totalDebit = 0;
    let totalCredit = 0;
    const accountIds = [];

    for (const p of postings) {
      if (!p.accountId || typeof p.accountId !== 'string') {
        throw new Error('[LedgerCore] Invalid accountId in posting');
      }
      if (!Number.isInteger(p.amount) || p.amount <= 0) {
        throw new Error(`[LedgerCore] Posting amount must be a positive integer in paise. Received: ${p.amount}`);
      }
      if (p.direction !== 'DEBIT' && p.direction !== 'CREDIT') {
        throw new Error(`[LedgerCore] Posting direction must be DEBIT or CREDIT. Received: ${p.direction}`);
      }

      accountIds.push(p.accountId);
      if (p.direction === 'DEBIT') totalDebit += p.amount;
      else totalCredit += p.amount;
    }

    // Invariant 2: sum(debits) === sum(credits)
    if (totalDebit !== totalCredit) {
      const err = new Error(`[LedgerCore] Unbalanced journal entry: Total DEBIT (₹${(totalDebit/100).toFixed(2)}) !== Total CREDIT (₹${(totalCredit/100).toFixed(2)})`);
      err.code = 'UNBALANCED_JOURNAL_ENTRY';
      throw err;
    }

    // Acquire locks deterministically
    const lockedAccountIds = await this.acquireLocks(accountIds);

    try {
      // Check idempotency again under lock
      if (this.idempotencyStore.has(idempotencyKey)) {
        return this.idempotencyStore.get(idempotencyKey).result;
      }

      // Check sufficient balance for liabilities/customer accounts being debited
      for (const p of postings) {
        const type = this.getAccountType(p.accountId);
        if (this.isCreditNormal(type) && p.direction === 'DEBIT') {
          // Debiting a liability reduces its balance (e.g. customer wallet or driver earnings)
          const currentBal = this.getBalance(p.accountId);
          if (currentBal < p.amount) {
            const err = new Error(`[LedgerCore] Insufficient balance in ${p.accountId}. Available: ₹${(currentBal/100).toFixed(2)}, required: ₹${(p.amount/100).toFixed(2)}`);
            err.code = 'INSUFFICIENT_FUNDS';
            throw err;
          }
        }
      }

      // Construct immutable journal entry
      const entryId = `JE_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const entry = {
        id: entryId,
        type,
        referenceId: referenceId || null,
        idempotencyKey,
        description,
        timestamp: new Date().toISOString(),
        postings: postings.map(p => ({
          accountId: p.accountId,
          accountType: this.getAccountType(p.accountId),
          direction: p.direction,
          amount: p.amount
        }))
      };

      // Apply to materialized balances
      for (const p of postings) {
        const current = this.getBalance(p.accountId);
        const type = this.getAccountType(p.accountId);
        const isCredit = this.isCreditNormal(type);
        const delta = isCredit
          ? (p.direction === 'CREDIT' ? p.amount : -p.amount)
          : (p.direction === 'DEBIT' ? p.amount : -p.amount);
        this.materializedBalances.set(p.accountId, current + delta);
      }

      this.entries.push(entry);
      this.save();

      const result = {
        success: true,
        entry,
        balances: Object.fromEntries(lockedAccountIds.map(accId => [accId, this.getBalance(accId)]))
      };

      const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ type, referenceId, postings })).digest('hex');
      this.idempotencyStore.set(idempotencyKey, { result, payloadHash });

      return result;
    } finally {
      this.releaseLocks(lockedAccountIds);
    }
  }

  /**
   * Run full reconciliation audit across all entries.
   */
  reconcile() {
    let totalDebits = 0;
    let totalCredits = 0;
    const auditBalances = new Map();

    for (const entry of this.entries) {
      let entryDebits = 0;
      let entryCredits = 0;
      for (const p of entry.postings) {
        if (p.direction === 'DEBIT') {
          entryDebits += p.amount;
          totalDebits += p.amount;
        } else {
          entryCredits += p.amount;
          totalCredits += p.amount;
        }

        const type = this.getAccountType(p.accountId);
        const isCredit = this.isCreditNormal(type);
        const current = auditBalances.get(p.accountId) || 0;
        const delta = isCredit
          ? (p.direction === 'CREDIT' ? p.amount : -p.amount)
          : (p.direction === 'DEBIT' ? p.amount : -p.amount);
        auditBalances.set(p.accountId, current + delta);
      }

      if (entryDebits !== entryCredits) {
        return {
          reconciled: false,
          error: `Entry ${entry.id} is unbalanced: DEBIT ${entryDebits} !== CREDIT ${entryCredits}`,
          imbalancePaise: Math.abs(entryDebits - entryCredits)
        };
      }
    }

    // Verify materialized balances match computed audit balances exactly
    for (const [accountId, expectedBal] of auditBalances.entries()) {
      const actualBal = this.getBalance(accountId);
      if (actualBal !== expectedBal) {
        return {
          reconciled: false,
          error: `Materialized balance mismatch for ${accountId}: actual ${actualBal} !== expected ${expectedBal}`,
          imbalancePaise: Math.abs(actualBal - expectedBal)
        };
      }
    }

    const ledgerImbalancePaise = totalDebits - totalCredits;
    return {
      reconciled: ledgerImbalancePaise === 0,
      totalEntries: this.entries.length,
      totalDebitsPaise: totalDebits,
      totalCreditsPaise: totalCredits,
      imbalancePaise: ledgerImbalancePaise,
      materializedAccounts: this.materializedBalances.size
    };
  }
}

module.exports = { LedgerCore, ACCOUNT_TYPES };
