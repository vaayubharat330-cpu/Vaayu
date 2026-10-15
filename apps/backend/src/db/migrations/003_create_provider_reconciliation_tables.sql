-- ============================================================================
-- 003_create_provider_reconciliation_tables.sql
-- VAAYU Phase F.5: Automated Provider Reconciliation Worker & Discrepancy Ledger
-- ============================================================================

-- 1. RECONCILIATION BATCH AUDIT RUNS
CREATE TABLE IF NOT EXISTS payment_reconciliation_batches (
    batch_id BIGSERIAL PRIMARY KEY,
    batch_ref VARCHAR(64) UNIQUE NOT NULL,                  -- 'RECON_RUN_20261012_001'
    provider VARCHAR(64) NOT NULL,                          -- 'razorpay'
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status VARCHAR(32) NOT NULL DEFAULT 'RUNNING'           -- 'RUNNING', 'COMPLETED', 'FAILED'
        CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
    total_records_checked INTEGER NOT NULL DEFAULT 0,
    matched_count INTEGER NOT NULL DEFAULT 0,
    discrepancy_count INTEGER NOT NULL DEFAULT 0,
    auto_resolved_count INTEGER NOT NULL DEFAULT 0,
    manual_review_count INTEGER NOT NULL DEFAULT 0,
    is_balanced BOOLEAN NOT NULL DEFAULT FALSE,
    summary JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_recon_batches_provider ON payment_reconciliation_batches(provider);
CREATE INDEX IF NOT EXISTS idx_recon_batches_started ON payment_reconciliation_batches(started_at);

-- 2. DISCREPANCY REGISTER TABLE
CREATE TABLE IF NOT EXISTS payment_discrepancy_records (
    discrepancy_id BIGSERIAL PRIMARY KEY,
    batch_ref VARCHAR(64) NOT NULL,
    provider VARCHAR(64) NOT NULL,
    discrepancy_type VARCHAR(64) NOT NULL
        CHECK (discrepancy_type IN (
            'MISSING_INTERNAL_ESCROW',   -- Provider captured, but internal webhook was missed/lost
            'FALSE_INTERNAL_SETTLEMENT', -- VAAYU settled, but provider reports payment failed/unauthorized
            'AMOUNT_MISMATCH',           -- Provider captured amount != internal order/escrow amount
            'CURRENCY_MISMATCH',         -- Non-INR currency reported by provider
            'STATUS_CONFLICT',           -- Provider refund != internal refund state
            'ORPHAN_PROVIDER_PAYMENT'    -- Provider has payment with no matching VAAYU order/trip
        )),
    provider_order_id VARCHAR(128),
    provider_payment_id VARCHAR(128),
    payment_id VARCHAR(64),
    trip_id VARCHAR(64),
    customer_id VARCHAR(64),
    provider_amount_paise BIGINT,
    internal_amount_paise BIGINT,
    provider_status VARCHAR(64),
    internal_status VARCHAR(64),
    resolution_status VARCHAR(32) NOT NULL DEFAULT 'OPEN'
        CHECK (resolution_status IN ('OPEN', 'AUTO_RESOLVED', 'RESOLVED_MANUAL', 'DISMISSED')),
    resolution_action VARCHAR(64),                          -- 'AUTO_HEALED_ESCROW', 'FLAGGED_MANUAL_REVIEW', etc.
    resolution_notes TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discrepancy_batch_ref ON payment_discrepancy_records(batch_ref);
CREATE INDEX IF NOT EXISTS idx_discrepancy_type ON payment_discrepancy_records(discrepancy_type);
CREATE INDEX IF NOT EXISTS idx_discrepancy_resolution ON payment_discrepancy_records(resolution_status);
CREATE INDEX IF NOT EXISTS idx_discrepancy_payment_id ON payment_discrepancy_records(payment_id);
CREATE INDEX IF NOT EXISTS idx_discrepancy_trip_id ON payment_discrepancy_records(trip_id);

-- 3. PERMISSIONS FOR APPLICATION USER
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'vaayu_app_limited') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON payment_reconciliation_batches TO vaayu_app_limited;
        GRANT SELECT, INSERT, UPDATE, DELETE ON payment_discrepancy_records TO vaayu_app_limited;
        GRANT USAGE, SELECT ON SEQUENCE payment_reconciliation_batches_batch_id_seq TO vaayu_app_limited;
        GRANT USAGE, SELECT ON SEQUENCE payment_discrepancy_records_discrepancy_id_seq TO vaayu_app_limited;
    END IF;
END $$;
