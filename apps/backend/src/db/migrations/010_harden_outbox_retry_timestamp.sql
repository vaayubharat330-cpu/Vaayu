-- ============================================================================
-- VAAYU PAYMENT OUTBOX RETRY TIMESTAMP INVARIANT
--
-- payment_outbox.next_attempt_at is NOT NULL. A permanently failed outbox
-- event must therefore retain a valid retry timestamp even though FAILED rows
-- are not eligible for normal polling. This guard prevents a dispatcher
-- failure path from violating the database invariant while preserving the
-- existing timestamp whenever one already exists.
-- ============================================================================

CREATE OR REPLACE FUNCTION enforce_payment_outbox_next_attempt_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.next_attempt_at IS NULL THEN
    NEW.next_attempt_at := COALESCE(OLD.next_attempt_at, NOW());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_outbox_next_attempt_at_guard ON payment_outbox;

CREATE TRIGGER payment_outbox_next_attempt_at_guard
BEFORE INSERT OR UPDATE ON payment_outbox
FOR EACH ROW
EXECUTE FUNCTION enforce_payment_outbox_next_attempt_at();
