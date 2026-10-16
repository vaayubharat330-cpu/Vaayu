-- ============================================================================
-- VAAYU PAYMENT OUTBOX LEASE HARDENING
--
-- A dispatcher must never hold a PostgreSQL transaction open while awaiting
-- WebSocket/custom downstream handlers. PROCESSING + claim_token gives each
-- worker an explicit lease so dispatch happens outside the DB transaction.
-- ============================================================================

ALTER TABLE payment_outbox
  DROP CONSTRAINT IF EXISTS payment_outbox_status_check;

ALTER TABLE payment_outbox
  ADD CONSTRAINT payment_outbox_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'));

ALTER TABLE payment_outbox
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_token VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_outbox_claim_token
  ON payment_outbox(claim_token)
  WHERE claim_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_outbox_processing_started
  ON payment_outbox(status, processing_started_at)
  WHERE status = 'PROCESSING';

-- Recover any pre-migration PROCESSING rows defensively if this migration is
-- ever applied to a database that already had an intermediate worker state.
UPDATE payment_outbox
SET status = 'PENDING',
    processing_started_at = NULL,
    claim_token = NULL,
    next_attempt_at = NOW()
WHERE status = 'PROCESSING';
