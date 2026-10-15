-- ============================================================================
-- VAAYU POSTGRESQL DOUBLE-ENTRY LEDGER & PAYMENT CORE SCHEMA (PHASE F.1)
-- ============================================================================

-- 1. LEDGER ACCOUNTS TABLE (Materialized Balances)
CREATE TABLE IF NOT EXISTS ledger_accounts (
    account_id VARCHAR(128) PRIMARY KEY,
    account_type VARCHAR(32) NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE')),
    normal_balance VARCHAR(16) NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
    balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
    debit_paise BIGINT NOT NULL DEFAULT 0 CHECK (debit_paise >= 0),
    credit_paise BIGINT NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_accounts_type ON ledger_accounts(account_type);

-- 2. JOURNAL ENTRIES TABLE (Strictly Immutable, Append-Only)
CREATE TABLE IF NOT EXISTS ledger_journal_entries (
    entry_id VARCHAR(64) PRIMARY KEY,
    sequence BIGSERIAL NOT NULL UNIQUE,
    reference_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    description TEXT NOT NULL,
    total_paise BIGINT NOT NULL CHECK (total_paise > 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_journal_entries_ref ON ledger_journal_entries(reference_id);
CREATE INDEX IF NOT EXISTS idx_ledger_journal_entries_seq ON ledger_journal_entries(sequence);
CREATE INDEX IF NOT EXISTS idx_ledger_journal_entries_created ON ledger_journal_entries(created_at);

-- 3. POSTINGS TABLE (Strictly Immutable, Append-Only)
CREATE TABLE IF NOT EXISTS ledger_postings (
    posting_id VARCHAR(64) PRIMARY KEY,
    entry_id VARCHAR(64) NOT NULL REFERENCES ledger_journal_entries(entry_id) ON DELETE RESTRICT,
    account_id VARCHAR(128) NOT NULL REFERENCES ledger_accounts(account_id) ON DELETE RESTRICT,
    side VARCHAR(16) NOT NULL CHECK (side IN ('DEBIT', 'CREDIT')),
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_postings_entry ON ledger_postings(entry_id);
CREATE INDEX IF NOT EXISTS idx_ledger_postings_account ON ledger_postings(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_postings_side ON ledger_postings(side);

-- 4. IDEMPOTENCY REGISTRY
CREATE TABLE IF NOT EXISTS ledger_idempotency (
    idempotency_key VARCHAR(128) PRIMARY KEY,
    request_hash VARCHAR(64) NOT NULL,
    entry_id VARCHAR(64) REFERENCES ledger_journal_entries(entry_id) ON DELETE SET NULL,
    response_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. PAYMENT TRANSACTIONS TABLE
CREATE TABLE IF NOT EXISTS payment_transactions (
    payment_id VARCHAR(64) PRIMARY KEY,
    trip_id VARCHAR(64) UNIQUE NOT NULL,
    order_id VARCHAR(64) NOT NULL,
    customer_id VARCHAR(64) NOT NULL,
    driver_id VARCHAR(64),
    currency VARCHAR(8) NOT NULL DEFAULT 'INR',
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    escrow_paise BIGINT NOT NULL DEFAULT 0 CHECK (escrow_paise >= 0),
    refunded_paise BIGINT NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
    commission_bps INTEGER NOT NULL DEFAULT 1000,
    commission_paise BIGINT NOT NULL DEFAULT 0 CHECK (commission_paise >= 0),
    gst_bps INTEGER NOT NULL DEFAULT 1800,
    gst_paise BIGINT NOT NULL DEFAULT 0 CHECK (gst_paise >= 0),
    driver_earnings_paise BIGINT NOT NULL DEFAULT 0 CHECK (driver_earnings_paise >= 0),
    state VARCHAR(32) NOT NULL DEFAULT 'INITIATED' CHECK (state IN ('INITIATED', 'ESCROWED', 'SETTLED', 'REFUNDED', 'EXPIRED', 'DISPUTED', 'ADJUSTED')),
    dispute_id VARCHAR(64),
    adjustment_paise BIGINT DEFAULT 0 CHECK (adjustment_paise >= 0),
    version INTEGER NOT NULL DEFAULT 1,
    transaction_id VARCHAR(64),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_trip ON payment_transactions(trip_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_customer ON payment_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_driver ON payment_transactions(driver_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_state ON payment_transactions(state);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_created ON payment_transactions(created_at);

-- 6. TRANSACTIONAL OUTBOX TABLE
CREATE TABLE IF NOT EXISTS payment_outbox (
    outbox_id BIGSERIAL PRIMARY KEY,
    event_id VARCHAR(64) UNIQUE NOT NULL,
    aggregate_type VARCHAR(64) NOT NULL DEFAULT 'PAYMENT',
    aggregate_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_payment_outbox_status_next ON payment_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_payment_outbox_event_id ON payment_outbox(event_id);

-- 7. DATABASE IMMUTABILITY TRIGGERS
-- Prevent any UPDATE or DELETE on ledger_journal_entries
CREATE OR REPLACE FUNCTION enforce_ledger_journal_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger_journal_entries is strictly immutable: % operations are prohibited', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_journal_immutable ON ledger_journal_entries;
CREATE TRIGGER trg_ledger_journal_immutable
BEFORE UPDATE OR DELETE ON ledger_journal_entries
FOR EACH ROW EXECUTE FUNCTION enforce_ledger_journal_immutability();

-- Prevent any UPDATE or DELETE on ledger_postings
CREATE OR REPLACE FUNCTION enforce_ledger_postings_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger_postings is strictly immutable: % operations are prohibited', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_postings_immutable ON ledger_postings;
CREATE TRIGGER trg_ledger_postings_immutable
BEFORE UPDATE OR DELETE ON ledger_postings
FOR EACH ROW EXECUTE FUNCTION enforce_ledger_postings_immutability();

-- 8. GRANT PRIVILEGES TO APPLICATION USER
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'vaayu_app_limited') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vaayu_app_limited;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vaayu_app_limited;
    END IF;
END $$;
