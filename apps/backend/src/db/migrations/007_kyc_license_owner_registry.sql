-- ============================================================================
-- VAAYU KYC: DRIVER-LICENSE OWNER REGISTRY
--
-- A composite unique index on (license, driver) only prevents duplicate rows
-- for the same pair. It does NOT prevent a second driver from claiming the
-- same licence. This registry makes licence ownership a true database-level
-- invariant while still allowing one driver to associate the licence with
-- multiple vehicle/document records.
-- ============================================================================

CREATE TABLE IF NOT EXISTS kyc_license_owners (
    license_number_hash VARCHAR(64) PRIMARY KEY,
    driver_id VARCHAR(128) NOT NULL,
    first_claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kyc_license_owners_driver
    ON kyc_license_owners(driver_id);

-- Backfill ownership only where historical data is unambiguous. If old data
-- already contains the same licence under multiple drivers, do not silently
-- choose an owner; leave it for operational remediation.
INSERT INTO kyc_license_owners (license_number_hash, driver_id)
SELECT license_number_hash, MIN(driver_id)
FROM driver_kyc_documents
WHERE license_number_hash IS NOT NULL
  AND document_type = 'DRIVING_LICENSE'
  AND decision <> 'REJECTED'
GROUP BY license_number_hash
HAVING COUNT(DISTINCT driver_id) = 1
ON CONFLICT (license_number_hash) DO NOTHING;

CREATE OR REPLACE FUNCTION enforce_kyc_license_owner()
RETURNS TRIGGER AS $$
DECLARE
    existing_driver VARCHAR(128);
BEGIN
    IF NEW.license_number_hash IS NULL
       OR NEW.document_type <> 'DRIVING_LICENSE'
       OR NEW.decision = 'REJECTED' THEN
        RETURN NEW;
    END IF;

    INSERT INTO kyc_license_owners (license_number_hash, driver_id)
    VALUES (NEW.license_number_hash, NEW.driver_id)
    ON CONFLICT (license_number_hash) DO NOTHING;

    SELECT driver_id
      INTO existing_driver
      FROM kyc_license_owners
     WHERE license_number_hash = NEW.license_number_hash;

    IF existing_driver IS DISTINCT FROM NEW.driver_id THEN
        RAISE EXCEPTION 'DRIVING_LICENSE_ALREADY_BOUND_TO_DRIVER'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kyc_license_owner ON driver_kyc_documents;
CREATE TRIGGER trg_kyc_license_owner
    BEFORE INSERT OR UPDATE OF license_number_hash, driver_id, document_type, decision
    ON driver_kyc_documents
    FOR EACH ROW EXECUTE FUNCTION enforce_kyc_license_owner();

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'vaayu_app_limited') THEN
        GRANT SELECT, INSERT, UPDATE ON kyc_license_owners TO vaayu_app_limited;
    END IF;
END $$;
