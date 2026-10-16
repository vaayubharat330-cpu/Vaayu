'use strict';

const crypto = require('crypto');
const { sanitizeExtractedFields, isSha256 } = require('./kycPrivacyPolicy');

function hashIdentity(value) {
  if (value == null || value === '') return null;
  return crypto.createHash('sha256').update(String(value).trim().toUpperCase()).digest('hex');
}

function json(value, fallback) {
  return value == null ? fallback : value;
}

/**
 * Durable KYC persistence boundary.
 *
 * The verification decision, canonical document projection and immutable run
 * history are committed together. A provider response is evidence, not a
 * mutable business-state cache.
 */
class KycVerificationPersistence {
  constructor({ pool } = {}) {
    this.pool = pool;
  }

  _requirePool() {
    if (!this.pool || typeof this.pool.withTransaction !== 'function') {
      throw new Error('KYC PostgreSQL persistence requires a transactional pool');
    }
    return this.pool;
  }

  async persistEvaluation(evaluation) {
    const pool = this._requirePool();
    const normalized = evaluation.normalizedFields || {};
    const issuer = evaluation.issuerVerification || {};
    const safeExtractedFields = sanitizeExtractedFields(normalized);
    const kycDocumentId = String(evaluation.kycDocumentId || evaluation.documentId || '');
    const runId = String(evaluation.verificationId || `kyc_${crypto.randomBytes(12).toString('hex')}`);
    if (!evaluation.driverId || !kycDocumentId || !evaluation.documentType) {
      const error = new Error('driverId, documentId and documentType are required for KYC persistence');
      error.code = 'KYC_PERSISTENCE_INPUT_INVALID';
      throw error;
    }
    if (evaluation.evidenceHash != null && !isSha256(evaluation.evidenceHash)) {
      const error = new Error('evidenceHash must be a SHA-256 hex digest');
      error.code = 'KYC_EVIDENCE_HASH_INVALID';
      throw error;
    }

    const evidenceHash = evaluation.evidenceHash || null;
    const issuerState = issuer.state || issuer.status || 'NOT_CONFIGURED';
    const provider = issuer.provider || issuer.source || null;
    const providerVerificationId = issuer.verificationId || issuer.providerVerificationId || null;
    const vehicleHash = hashIdentity(normalized.vehicleNumber);
    const chassisHash = hashIdentity(normalized.chassisLast5);
    const engineHash = hashIdentity(normalized.engineLast5);
    const licenseHash = hashIdentity(normalized.licenseNumber);
    const policyHash = hashIdentity(normalized.policyNumber);
    const panHash = hashIdentity(normalized.panNumber);
    const aadhaarReferenceHash = hashIdentity(normalized.aadhaarReference || normalized.aadhaarLast4);
    const expiresAt = evaluation.expiresAt || null;

    return pool.withTransaction(async (client) => {
      const existing = await client.query(
        'SELECT * FROM driver_kyc_documents WHERE kyc_document_id = $1 FOR UPDATE',
        [kycDocumentId]
      );

      let row;
      let fromDecision = null;
      if (existing.rowCount) {
        row = existing.rows[0];
        fromDecision = row.decision;
        const updated = await client.query(
          `UPDATE driver_kyc_documents
             SET driver_id = $1, document_id = $2, document_type = $3,
                 decision = $4, issuer_state = $5, provider = $6,
                 provider_verification_id = $7, vehicle_number_normalized = NULL,
                 chassis_hash = $8, engine_hash = $9, license_number_hash = $10,
                 policy_number_hash = $11, pan_hash = $12, aadhaar_reference_hash = $13,
                 evidence_hash = $14, reasons = $15::jsonb, warnings = $16::jsonb,
                 extracted_fields = $17::jsonb, expires_at = $18, updated_at = NOW()
           WHERE kyc_document_id = $19
           RETURNING *`,
          [
            evaluation.driverId, evaluation.documentId, evaluation.documentType,
            evaluation.decision, issuerState, provider, providerVerificationId,
            chassisHash, engineHash, licenseHash, policyHash, panHash,
            aadhaarReferenceHash, evidenceHash,
            JSON.stringify(evaluation.reasons || []), JSON.stringify(evaluation.warnings || []),
            JSON.stringify(safeExtractedFields), expiresAt, kycDocumentId
          ]
        );
        row = updated.rows[0];
      } else {
        const inserted = await client.query(
          `INSERT INTO driver_kyc_documents
             (kyc_document_id, driver_id, document_id, document_type, decision,
              issuer_state, provider, provider_verification_id,
              vehicle_number_normalized, chassis_hash, engine_hash, license_number_hash,
              policy_number_hash, pan_hash, aadhaar_reference_hash, evidence_hash,
              reasons, warnings, extracted_fields, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19)
           RETURNING *`,
          [
            kycDocumentId, evaluation.driverId, evaluation.documentId, evaluation.documentType,
            evaluation.decision, issuerState, provider, providerVerificationId,
            chassisHash, engineHash, licenseHash, policyHash, panHash, aadhaarReferenceHash,
            evidenceHash, JSON.stringify(evaluation.reasons || []), JSON.stringify(evaluation.warnings || []),
            JSON.stringify(safeExtractedFields), expiresAt
          ]
        );
        row = inserted.rows[0];
      }

      await client.query(
        `INSERT INTO driver_kyc_decision_history
           (kyc_document_id, from_decision, to_decision, actor_id, actor_role, reason, evidence_hash, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          row.kyc_document_id, fromDecision, evaluation.decision,
          evaluation.actorId || 'SYSTEM', evaluation.actorRole || 'KYC_ENGINE',
          (evaluation.reasons || []).join(', ').slice(0, 1000), evidenceHash,
          JSON.stringify({ verificationId: runId, issuerState, provider })
        ]
      );

      await client.query(
        `INSERT INTO driver_kyc_verification_runs
           (run_id, kyc_document_id, driver_id, document_id, document_type, decision,
            issuer_state, provider, provider_verification_id, evidence_hash, reasons,
            warnings, normalized_fields, capture_gate, consistency, provider_result, evaluated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17)`,
        [
          runId, row.kyc_document_id, evaluation.driverId, evaluation.documentId,
          evaluation.documentType, evaluation.decision, issuerState, provider,
          providerVerificationId, evidenceHash, JSON.stringify(evaluation.reasons || []),
          JSON.stringify(evaluation.warnings || []), JSON.stringify(safeExtractedFields),
          JSON.stringify(json(evaluation.captureGate, {})), JSON.stringify(json(evaluation.consistency, {})),
          JSON.stringify(issuer), evaluation.evaluatedAt || new Date().toISOString()
        ]
      );

      return { success: true, kycDocument: row, verificationId: runId };
    }).catch((error) => {
      if (error && error.code === '23505') error.code = 'KYC_IDENTITY_CONFLICT';
      throw error;
    });
  }
}

module.exports = { KycVerificationPersistence, hashIdentity };
