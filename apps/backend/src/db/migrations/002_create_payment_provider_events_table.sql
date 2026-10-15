-- ============================================================================
-- 002_create_payment_provider_events_table.sql
-- VAAYU Phase F.4: Provider Ingestion & Payment-Rail Boundary
-- ============================================================================

-- 1. PROVIDER WEBHOOK EVENTS (Audit & Ingestion Ledger)
CREATE TABLE IF NOT EXISTS payment_provider_events (
    event_pk BIGSERIAL PRIMARY KEY,
    provider VARCHAR(64) NOT NULL,                        -- 'razorpay', 'upi_intent', 'cash', etc.
    provider_event_id VARCHAR(128) NOT NULL,               -- Unique event ID assigned by provider (e.g. 'evt_xyz')
    event_type VARCHAR(128) NOT NULL,                      -- Normalized or raw event name (e.g. 'payment.captured')
    payload_hash VARCHAR(64) NOT NULL,                     -- SHA-256 hash of raw incoming payload
    raw_payload JSONB NOT NULL,                            -- Full verified webhook payload
    signature VARCHAR(256),                                -- Cryptographic signature from request headers
    status VARCHAR(32) NOT NULL DEFAULT 'RECEIVED'         -- 'RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'
        CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
    matched_payment_id VARCHAR(64),                        -- Correlated VAAYU paymentId (e.g. 'PAY_TRIP_123')
    matched_trip_id VARCHAR(64),                           -- Correlated VAAYU tripId (e.g. 'TRIP_123')
    amount_paise BIGINT,                                   -- Verified transaction amount in paise
    currency VARCHAR(16) DEFAULT 'INR',                    -- Currency
    idempotent_replay BOOLEAN NOT NULL DEFAULT FALSE,      -- Flagged when event is replayed safely
    processing_error TEXT,                                 -- Diagnostics if rejected or failed
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,

    CONSTRAINT uq_provider_event UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_events_status ON payment_provider_events(status);
CREATE INDEX IF NOT EXISTS idx_provider_events_matched_payment ON payment_provider_events(matched_payment_id);
CREATE INDEX IF NOT EXISTS idx_provider_events_matched_trip ON payment_provider_events(matched_trip_id);
CREATE INDEX IF NOT EXISTS idx_provider_events_created ON payment_provider_events(created_at);

-- 2. PROVIDER PAYMENT ORDER MAPPINGS
-- Explicit correlation between provider order/payment IDs and internal VAAYU entities
CREATE TABLE IF NOT EXISTS payment_provider_mappings (
    mapping_id BIGSERIAL PRIMARY KEY,
    provider VARCHAR(64) NOT NULL,
    provider_order_id VARCHAR(128),
    provider_payment_id VARCHAR(128),
    payment_id VARCHAR(64) NOT NULL,
    trip_id VARCHAR(64) NOT NULL,
    order_id VARCHAR(64),
    customer_id VARCHAR(64) NOT NULL,
    expected_amount_paise BIGINT NOT NULL,
    currency VARCHAR(16) NOT NULL DEFAULT 'INR',
    status VARCHAR(32) NOT NULL DEFAULT 'INITIATED' CHECK (status IN ('INITIATED', 'AUTHORIZED', 'CAPTURED', 'REFUNDED', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_mapping_provider_order UNIQUE (provider, provider_order_id),
    CONSTRAINT uq_mapping_payment_id UNIQUE (payment_id)
);

CREATE INDEX IF NOT EXISTS idx_mapping_provider_payment ON payment_provider_mappings(provider, provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_mapping_trip_id ON payment_provider_mappings(trip_id);
CREATE INDEX IF NOT EXISTS idx_mapping_customer_id ON payment_provider_mappings(customer_id);

-- 3. PERMISSIONS FOR APPLICATION USER
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'vaayu_app_limited') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON payment_provider_events TO vaayu_app_limited;
        GRANT SELECT, INSERT, UPDATE, DELETE ON payment_provider_mappings TO vaayu_app_limited;
        GRANT USAGE, SELECT ON SEQUENCE payment_provider_events_event_pk_seq TO vaayu_app_limited;
        GRANT USAGE, SELECT ON SEQUENCE payment_provider_mappings_mapping_id_seq TO vaayu_app_limited;
    END IF;
END $$;
