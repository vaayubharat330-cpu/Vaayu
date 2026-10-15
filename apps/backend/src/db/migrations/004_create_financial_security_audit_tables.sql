-- ============================================================================
-- 004_create_financial_security_audit_tables.sql
-- VAAYU Phase F.6: Financial Security, Forensic Audit Trail & Dual-Control Approvals
-- ============================================================================

-- 1. IMMUTABLE ADMINISTRATIVE FINANCIAL AUDIT TRAIL
CREATE TABLE IF NOT EXISTS financial_audit_trail (
    audit_id VARCHAR(64) PRIMARY KEY,
    actor_id VARCHAR(128) NOT NULL,
    actor_role VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,
    resource_type VARCHAR(64) NOT NULL,
    resource_id VARCHAR(128) NOT NULL,
    reason TEXT,
    request_id VARCHAR(128),
    idempotency_key VARCHAR(64),
    before_state_hash VARCHAR(64),
    after_state_hash VARCHAR(64),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(64),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_trail_actor ON financial_audit_trail(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_trail_action ON financial_audit_trail(action);
CREATE INDEX IF NOT EXISTS idx_audit_trail_resource ON financial_audit_trail(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_trail_created ON financial_audit_trail(created_at);

-- Trigger: Enforce Append-Only Immutability on Financial Audit Trail
CREATE OR REPLACE FUNCTION enforce_financial_audit_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'financial_audit_trail is strictly append-only. Modifying or deleting audit records is forbidden.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_financial_audit_trail_immutable ON financial_audit_trail;
CREATE TRIGGER trg_financial_audit_trail_immutable
    BEFORE UPDATE OR DELETE ON financial_audit_trail
    FOR EACH ROW
    EXECUTE FUNCTION enforce_financial_audit_immutability();

-- 2. FOUR-EYES DUAL-CONTROL APPROVAL REQUESTS (MAKER-CHECKER)
CREATE TABLE IF NOT EXISTS financial_approval_requests (
    request_id VARCHAR(64) PRIMARY KEY,
    operation_type VARCHAR(64) NOT NULL,                     -- 'HIGH_VALUE_REFUND', 'MANUAL_ADJUSTMENT', 'PAYOUT_OVERRIDE', 'BALANCE_CORRECTION'
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING_APPROVAL'
        CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTED')),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    amount_paise BIGINT NOT NULL DEFAULT 0,
    threshold_paise BIGINT NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    requested_by VARCHAR(128) NOT NULL,
    requested_by_role VARCHAR(64) NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_by VARCHAR(128),
    approved_by_role VARCHAR(64),
    decided_at TIMESTAMPTZ,
    decision_notes TEXT,
    execution_idempotency_key VARCHAR(64),
    execution_result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON financial_approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approvals_requested_by ON financial_approval_requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_approvals_created_at ON financial_approval_requests(created_at);

-- 3. EXPAND DISCREPANCY RECORD STATUS & PREVENT DELETION
ALTER TABLE payment_discrepancy_records 
    DROP CONSTRAINT IF EXISTS payment_discrepancy_records_resolution_status_check;

ALTER TABLE payment_discrepancy_records 
    ADD CONSTRAINT payment_discrepancy_records_resolution_status_check
    CHECK (resolution_status IN ('OPEN', 'INVESTIGATING', 'RESOLVED', 'RESOLVED_MANUAL', 'ESCALATED', 'DISMISSED', 'AUTO_RESOLVED'));

-- Prevent deletion of discrepancy records (Must preserve original records forever)
CREATE OR REPLACE FUNCTION enforce_discrepancy_record_retention()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'payment_discrepancy_records cannot be deleted. Discrepancy history is immutable.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_discrepancy_deletion ON payment_discrepancy_records;
CREATE TRIGGER trg_prevent_discrepancy_deletion
    BEFORE DELETE ON payment_discrepancy_records
    FOR EACH ROW
    EXECUTE FUNCTION enforce_discrepancy_record_retention();

-- 4. DISCREPANCY RESOLUTION WORKFLOW HISTORY TABLE
CREATE TABLE IF NOT EXISTS payment_discrepancy_history (
    history_id BIGSERIAL PRIMARY KEY,
    discrepancy_id BIGINT NOT NULL REFERENCES payment_discrepancy_records(discrepancy_id),
    from_status VARCHAR(32) NOT NULL,
    to_status VARCHAR(32) NOT NULL,
    actor_id VARCHAR(128) NOT NULL,
    actor_role VARCHAR(64) NOT NULL,
    reason TEXT NOT NULL,
    corrective_transaction_ref VARCHAR(128),
    before_state JSONB DEFAULT '{}'::jsonb,
    after_state JSONB DEFAULT '{}'::jsonb,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discrepancy_history_discrepancy ON payment_discrepancy_history(discrepancy_id);
CREATE INDEX IF NOT EXISTS idx_discrepancy_history_actor ON payment_discrepancy_history(actor_id);

-- Enforce Immutability on Discrepancy History
CREATE OR REPLACE FUNCTION enforce_discrepancy_history_immutability()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'payment_discrepancy_history is strictly append-only. Modifying or deleting workflow history is forbidden.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_discrepancy_history_immutable ON payment_discrepancy_history;
CREATE TRIGGER trg_discrepancy_history_immutable
    BEFORE UPDATE OR DELETE ON payment_discrepancy_history
    FOR EACH ROW
    EXECUTE FUNCTION enforce_discrepancy_history_immutability();

-- 5. GRANTS FOR LIMITED APPLICATION USER
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'vaayu_app_limited') THEN
        GRANT SELECT, INSERT ON financial_audit_trail TO vaayu_app_limited;
        GRANT SELECT, INSERT, UPDATE ON financial_approval_requests TO vaayu_app_limited;
        GRANT SELECT, INSERT ON payment_discrepancy_history TO vaayu_app_limited;
        GRANT USAGE, SELECT ON SEQUENCE payment_discrepancy_history_history_id_seq TO vaayu_app_limited;
    END IF;
END $$;
