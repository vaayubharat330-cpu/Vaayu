-- ============================================================================
-- VAAYU KYC: VERIFICATION RUN HISTORY
-- Durable, append-only record of every automated KYC evaluation.
-- Raw images are never copied into this table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS driver_kyc_verification_runs (
    run_id VARCHAR(64) PRIMARY KEY,
    kyc_document_id VARCHAR(64) NOT NULL REFERENCES driver_kyc_documents(kyc_document_id) ON DELETE RESTRICT,
    driver_id VARCHAR(128) NOT NULL,
    document_id VARCHAR(128) NOT NULL,
    document_type VARCHAR(32) NOT NULL,
    decision VARCHAR(32) NOT NULL,
    issuer_state VARCHAR(32),
    provider VARCHAR(128),
    provider_verification_id VARCHAR(256),
    evidence_hash VARCHAR(64),
    reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    normalized_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    capture_gate JSONB NOT NULL DEFAULT '{}'::jsonb,
    consistency JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider_result JSONB NOT NULL DEFAULT '{}'::jsonb,
    evaluated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kyc_runs_document ON driver_kyc_verification_runs(kyc_document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_runs_driver ON driver_kyc_verification_runs(driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kyc_runs_decision ON driver_kyc_verification_runs(decision, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_kyc_run_history_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'driver_kyc_verification_runs is append-only.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kyc_run_history_immutable ON driver_kyc_verification_runs;
CREATE TRIGGER trg_kyc_run_history_immutable
    BEFORE UPDATE OR DELETE ON driver_kyc_verification_runs
    FOR EACH ROW EXECUTE FUNCTION enforce_kyc_run_history_immutability();

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'vaayu_app_limited') THEN
        GRANT SELECT, INSERT ON driver_kyc_verification_runs TO vaayu_app_limited;
    END IF;
END $$;
