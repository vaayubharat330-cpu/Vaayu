-- ============================================================================
-- VAAYU KYC FIX: DRIVER-LICENSE OWNERSHIP SEMANTICS
-- A driver's licence is person-bound, not vehicle-bound.
-- The same driver may submit the same licence for multiple vehicle records.
-- A different driver must never be able to claim that licence.
-- ============================================================================

DROP INDEX IF EXISTS uq_kyc_license_owner;

CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_license_owner
    ON driver_kyc_documents(license_number_hash, driver_id)
    WHERE license_number_hash IS NOT NULL
      AND document_type = 'DRIVING_LICENSE'
      AND decision <> 'REJECTED';

CREATE INDEX IF NOT EXISTS idx_kyc_license_lookup
    ON driver_kyc_documents(license_number_hash)
    WHERE license_number_hash IS NOT NULL
      AND document_type = 'DRIVING_LICENSE'
      AND decision <> 'REJECTED';
