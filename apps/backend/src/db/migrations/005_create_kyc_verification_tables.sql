-- ============================================================================
-- VAAYU KYC VERIFICATION & IDENTITY OWNERSHIP
-- Race-safe canonical registry for driver documents and verification decisions.
-- Raw document images remain outside this table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS driver_kyc_documents (
    kyc_document_id VARCHAR(64) PRIMARY KEY,
    driver_id VARCHAR(128) NOT NULL,
    document_id VARCHAR(128) NOT NULL,
    document_type VARCHAR(32) NOT NULL CHECK (document_type IN ('RC', 'VEHICLE_PHOTO', 'DRIVING_LICENSE', 'INSURANCE', 'PAN', 'AADHAAR', 'PROFILE_PHOTO')),
    decision VARCHAR(32) NOT NULL DEFAULT 'PENDING_PARTNER_ACCESS'
        CHECK (decision IN ('VERIFIED', 'REJECTED', 'RETAKE', 'HUMAN_REVIEW', 'PENDING_PARTNER_ACCESS')),
    issuer_state VARCHAR(32) NOT NULL DEFAULT 'NOT_CONFIGURED'
        CHECK (issuer_state IN ('NOT_CONFIGURED', 'UNAVAILABLE', 'PENDING_PARTNER_ACCESS', 'VERIFIED_MATCH', 'VERIFIED_REJECTED')),
    provider VARCHAR(128),
    provider_verification_id VARCHAR(256),
    vehicle_number_normalized VARCHAR(32),
    chassis_hash VARCHAR(64),
    engine_hash VARCHAR(64),
    license_number_hash VARCHAR(64),
    policy_number_hash VARCHAR(64),
    pan_hash VARCHAR(64),
    aadhaar_reference_hash VARCHAR(64),
    evidence_hash VARCHAR(64),
    risk_score NUMERIC(6,3),
    reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    extracted_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    expires_at TIMESTAMPTZ,
    reviewed_by VARCHAR(128),
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (driver_id, document_id)
);

-- A vehicle identity can belong to only one active VAAYU driver registration.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_vehicle_number
    ON driver_kyc_documents(vehicle_number_normalized)
    WHERE vehicle_number_normalized IS NOT NULL
      AND document_type IN ('RC', 'VEHICLE_PHOTO')
      AND decision <> 'REJECTED';

-- A physical chassis/engine identity is also globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_chassis_hash
    ON driver_kyc_documents(chassis_hash)
    WHERE chassis_hash IS NOT NULL
      AND document_type = 'RC'
      AND decision <> 'REJECTED';

CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_engine_hash
    ON driver_kyc_documents(engine_hash)
    WHERE engine_hash IS NOT NULL
      AND document_type = 'RC'
      AND decision <> 'REJECTED';

-- A driving licence identifies a person, not a vehicle. Therefore the licence
-- may be associated with multiple vehicle records for the SAME driver, but it
-- cannot be attached to a different driver.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_license_owner
    ON driver_kyc_documents(license_number_hash)
    WHERE license_number_hash IS NOT NULL
      AND document_type = 'DRIVING_LICENSE'
      AND decision <> 'REJECTED';

CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_policy_number
    ON driver_kyc_documents(policy_number_hash)
    WHERE policy_number_hash IS NOT NULL
      AND document_type = 'INSURANCE'
      AND decision <> 'REJECTED';

CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_pan
    ON driver_kyc_documents(pan_hash)
    WHERE pan_hash IS NOT NULL
      AND document_type = 'PAN'
      AND decision <> 'REJECTED';

CREATE INDEX IF NOT EXISTS idx_kyc_driver ON driver_kyc_documents(driver_id);
CREATE INDEX IF NOT EXISTS idx_kyc_decision ON driver_kyc_documents(decision);
CREATE INDEX IF NOT EXISTS idx_kyc_expiry ON driver_kyc_documents(expires_at);
CREATE INDEX IF NOT EXISTS idx_kyc_provider ON driver_kyc_documents(provider, issuer_state);

CREATE TABLE IF NOT EXISTS driver_kyc_decision_history (
    history_id BIGSERIAL PRIMARY KEY,
    kyc_document_id VARCHAR(64) NOT NULL REFERENCES driver_kyc_documents(kyc_document_id) ON DELETE RESTRICT,
    from_decision VARCHAR(32),
    to_decision VARCHAR(32) NOT NULL,
    actor_id VARCHAR(128),
    actor_role VARCHAR(64),
    reason TEXT,
    evidence_hash VARCHAR(64),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kyc_history_document ON driver_kyc_decision_history(kyc_document_id);
CREATE INDEX IF NOT EXISTS idx_kyc_history_created ON driver_kyc_decision_history(created_at);

CREATE OR REPLACE FUNCTION enforce_kyc_history_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'driver_kyc_decision_history is append-only.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kyc_history_immutable ON driver_kyc_decision_history;
CREATE TRIGGER trg_kyc_history_immutable
    BEFORE UPDATE OR DELETE ON driver_kyc_decision_history
    FOR EACH ROW EXECUTE FUNCTION enforce_kyc_history_immutability();

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'vaayu_app_limited') THEN
        GRANT SELECT, INSERT, UPDATE ON driver_kyc_documents TO vaayu_app_limited;
        GRANT SELECT, INSERT ON driver_kyc_decision_history TO vaayu_app_limited;
        GRANT USAGE, SELECT ON SEQUENCE driver_kyc_decision_history_history_id_seq TO vaayu_app_limited;
    END IF;
END $$;
