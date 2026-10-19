'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class LedgerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.details = details;
  }
}

class KeyedMutex {
  constructor() {
    this.queues = new Map();
  }

  async runExclusive(keys, fn) {
    const unique = [...new Set(keys)].sort();
    const releases = [];

    for (const key of unique) {
      const previous = this.queues.get(key) || Promise.resolve();
      let release;
      const current = new Promise(resolve => { release = resolve; });
      this.queues.set(key, previous.then(() => current));
      await previous;
      releases.push([key, release]);
    }

    try {
      return await fn();
    } finally {
      for (const [key, release] of releases.reverse()) {
        release();
        const queued = this.queues.get(key);
        if (queued) {
          queued.then(() => {
            if (this.queues.get(key) === queued) this.queues.delete(key);
          }).catch(() => {});
        }
      }
    }
  }
}

const ACCOUNT_TYPES = Object.freeze({
  ASSET: 'ASSET',
  LIABILITY: 'LIABILITY',
  REVENUE: 'REVENUE',
  EXPENSE: 'EXPENSE',
});

const NORMAL_BALANCE = Object.freeze({
  ASSET: 'DEBIT',
  EXPENSE: 'DEBIT',
  LIABILITY: 'CREDIT',
  REVENUE: 'CREDIT',
});

function assertPositiveIntegerPaise(amountPaise) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new LedgerError('INVALID_AMOUNT', 'Amount must be a positive integer number of paise.');
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class JsonLedgerRepository {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.dir = path.dirname(this.filePath);
    this.state = this._load();
  }

  _initialState() {
    return {
      schemaVersion: 1,
      sequence: 0,
      accounts: {},
      journalEntries: [],
      idempotency: {},
    };
  }

  _load() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) return this._initialState();
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (parsed.schemaVersion !== 1) {
      throw new LedgerError('UNSUPPORTED_SCHEMA', `Unsupported ledger schema: ${parsed.schemaVersion}`);
    }
    return parsed;
  }

  snapshot() {
    return clone(this.state);
  }

  replace(nextState) {
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(nextState, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    this.state = nextState;
  }
}

class LedgerService {
  constructor({ repository, clock = () => new Date().toISOString() } = {}) {
    if (!repository) throw new Error('LedgerService requires a repository.');
    this.repository = repository;
    this.clock = clock;
    this.mutex = new KeyedMutex();
  }

  createAccount({ accountId, type, currency = 'INR', metadata = {} }) {
    if (!accountId || !Object.values(ACCOUNT_TYPES).includes(type)) {
      throw new LedgerError('INVALID_ACCOUNT', 'accountId and valid account type are required.');
    }
    const state = this.repository.snapshot();
    if (state.accounts[accountId]) return clone(state.accounts[accountId]);

    state.accounts[accountId] = {
      accountId,
      type,
      currency,
      normalBalance: NORMAL_BALANCE[type],
      balancePaise: 0,
      debitPaise: 0,
      creditPaise: 0,
      createdAt: this.clock(),
      metadata,
    };
    this.repository.replace(state);
    return clone(state.accounts[accountId]);
  }

  ensureAccount(accountId, type, metadata = {}) {
    const state = this.repository.snapshot();
    if (state.accounts[accountId]) {
      if (state.accounts[accountId].type !== type) {
        throw new LedgerError('ACCOUNT_TYPE_MISMATCH', `Account ${accountId} already exists with another type.`);
      }
      return state.accounts[accountId];
    }
    return this.createAccount({ accountId, type, metadata });
  }

  getAccount(accountId) {
    const account = this.repository.snapshot().accounts[accountId];
    if (!account) throw new LedgerError('ACCOUNT_NOT_FOUND', `Account not found: ${accountId}`);
    return clone(account);
  }

  listAccounts() {
    return Object.values(this.repository.snapshot().accounts).map(clone);
  }

  getJournalEntry(entryId) {
    const entry = this.repository.snapshot().journalEntries.find(e => e.entryId === entryId);
    return entry ? clone(entry) : null;
  }

  postJournalEntry({ referenceId, idempotencyKey = referenceId, description, postings, metadata = {} }) {
    if (!referenceId || !idempotencyKey || !description) {
      throw new LedgerError('INVALID_ENTRY', 'referenceId, idempotencyKey and description are required.');
    }
    if (!Array.isArray(postings) || postings.length < 2) {
      throw new LedgerError('INVALID_POSTINGS', 'A journal entry requires at least two postings.');
    }

    const accountIds = postings.map(p => p.accountId);
    return this.mutex.runExclusive(accountIds, async () => {
      const state = this.repository.snapshot();

      const existing = state.idempotency[idempotencyKey];
      if (existing) {
        if (existing.requestHash !== this._requestHash({ referenceId, description, postings, metadata })) {
          throw new LedgerError('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different request.');
        }
        return { ...clone(existing.result), idempotentReplay: true };
      }

      const normalized = postings.map((posting, index) => {
        if (!posting.accountId || !['DEBIT', 'CREDIT'].includes(posting.side)) {
          throw new LedgerError('INVALID_POSTING', `Invalid posting at index ${index}.`);
        }
        assertPositiveIntegerPaise(posting.amountPaise);
        if (!state.accounts[posting.accountId]) {
          throw new LedgerError('ACCOUNT_NOT_FOUND', `Account not found: ${posting.accountId}`);
        }
        return {
          postingId: crypto.randomUUID(),
          accountId: posting.accountId,
          side: posting.side,
          amountPaise: posting.amountPaise,
          metadata: posting.metadata || {},
        };
      });

      const debits = normalized.filter(p => p.side === 'DEBIT').reduce((s, p) => s + p.amountPaise, 0);
      const credits = normalized.filter(p => p.side === 'CREDIT').reduce((s, p) => s + p.amountPaise, 0);
      if (debits !== credits) {
        throw new LedgerError('UNBALANCED_ENTRY', `Debits (${debits}) must equal credits (${credits}).`, { debits, credits });
      }

      const next = clone(state);
      for (const posting of normalized) {
        const account = next.accounts[posting.accountId];
        if (posting.side === 'DEBIT') account.debitPaise += posting.amountPaise;
        else account.creditPaise += posting.amountPaise;
        account.balancePaise = account.normalBalance === posting.side
          ? account.balancePaise + posting.amountPaise
          : account.balancePaise - posting.amountPaise;
        if (account.balancePaise < 0) {
          throw new LedgerError('INSUFFICIENT_FUNDS', `Insufficient balance in ${account.accountId}.`, {
            accountId: account.accountId,
            balancePaise: account.balancePaise + (account.normalBalance === posting.side ? -posting.amountPaise : posting.amountPaise),
            attemptedDebitPaise: posting.side === 'DEBIT' ? posting.amountPaise : 0,
          });
        }
      }

      next.sequence += 1;
      const entry = {
        entryId: `JE-${String(next.sequence).padStart(10, '0')}`,
        referenceId,
        idempotencyKey,
        description,
        postings: normalized,
        totalPaise: debits,
        metadata,
        createdAt: this.clock(),
      };
      next.journalEntries.push(entry);
      next.idempotency[idempotencyKey] = {
        requestHash: this._requestHash({ referenceId, description, postings, metadata }),
        result: { entryId: entry.entryId, referenceId, totalPaise: debits },
      };
      this.repository.replace(next);
      return clone(next.idempotency[idempotencyKey].result);
    });
  }

  _requestHash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  reconcile() {
    const state = this.repository.snapshot();
    const problems = [];
    const expected = {};
    let totalDebitsPaise = 0;
    let totalCreditsPaise = 0;

    for (const account of Object.values(state.accounts)) {
      expected[account.accountId] = { debitPaise: 0, creditPaise: 0 };
    }

    for (const entry of state.journalEntries) {
      const debits = entry.postings.filter(p => p.side === 'DEBIT').reduce((s, p) => s + p.amountPaise, 0);
      const credits = entry.postings.filter(p => p.side === 'CREDIT').reduce((s, p) => s + p.amountPaise, 0);
      totalDebitsPaise += debits;
      totalCreditsPaise += credits;
      if (debits !== credits) problems.push(`Unbalanced journal ${entry.entryId}`);
      for (const p of entry.postings) {
        if (!expected[p.accountId]) problems.push(`Posting references missing account ${p.accountId}`);
        else expected[p.accountId][p.side === 'DEBIT' ? 'debitPaise' : 'creditPaise'] += p.amountPaise;
      }
    }

    for (const account of Object.values(state.accounts)) {
      const e = expected[account.accountId];
      const computed = account.normalBalance === 'DEBIT'
        ? e.debitPaise - e.creditPaise
        : e.creditPaise - e.debitPaise;
      if (computed !== account.balancePaise || e.debitPaise !== account.debitPaise || e.creditPaise !== account.creditPaise) {
        problems.push(`Balance mismatch: ${account.accountId}`);
      }
    }

    return {
      ok: problems.length === 0,
      problems,
      journalEntries: state.journalEntries.length,
      journalEntriesCount: state.journalEntries.length,
      totalDebitsPaise,
      totalCreditsPaise,
      balanced: totalDebitsPaise === totalCreditsPaise
    };
  }
}

module.exports = {
  LedgerService,
  JsonLedgerRepository,
  LedgerError,
  ACCOUNT_TYPES,
  NORMAL_BALANCE,
};
