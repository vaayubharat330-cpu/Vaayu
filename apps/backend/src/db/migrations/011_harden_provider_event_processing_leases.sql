-- ============================================================================
-- 011_harden_provider_event_processing_leases.sql
-- Provider webhook concurrency/recovery hardening.
-- ============================================================================

-- PROCESSING separates an event that has been claimed for financial execution
-- from a RECEIVED event that has not yet been claimed.  The timestamp provides
-- a bounded recovery point if the process crashes after the claim is committed.
ALTER TABLE payment_provider_events
    DROP CONSTRAINT IF EXISTS payment_provider_events_status_check;

ALTER TABLE payment_provider_events
    ADD CONSTRAINT payment_provider_events_status_check
    CHECK (status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED'));

ALTER TABLE payment_provider_events
    ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_provider_events_processing_lease
    ON payment_provider_events(status, processing_started_at)
    WHERE status = 'PROCESSING';
