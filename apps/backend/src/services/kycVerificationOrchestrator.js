'use strict';

const crypto = require('crypto');
const { evaluateDocument } = require('./documentVerificationService');
const { buildDefaultProviderRegistry } = require('./documentVerificationProviders');
const { decide } = require('./documentVerificationDecisionEngine');

/**
 * Single orchestration boundary for KYC.
 *
 * This is intentionally usable by HTTP routes, background workers and future
 * provider integrations. It never turns OCR into authenticity proof.
 */
class KycVerificationOrchestrator {
  constructor({ db, providerRegistry = null, now = () => new Date() } = {}) {
    this.db = db;
    this.providerRegistry = providerRegistry || buildDefaultProviderRegistry();
    this.now = now;
  }

  async evaluate({ driverId, documentId, documentType, fields, signals = {}, officialVerification = null }) {
    const internal = evaluateDocument({
      db: this.db,
      driverId,
      documentType,
      fields,
      currentDocumentId: documentId,
      officialVerification: officialVerification || null,
    });

    let issuer = officialVerification;
    if (!issuer && documentType !== 'PROFILE_PHOTO' && documentType !== 'VEHICLE_PHOTO') {
      issuer = await this.providerRegistry.verify(documentType, {
        driverId,
        documentId,
        documentType,
        fields: internal.normalizedFields,
      });
    }

    const final = decide({
      signals,
      conflicts: [
        ...internal.uniquenessConflicts.map(conflict => ({
          type: conflict.code === 'IDENTITY_ALREADY_REGISTERED' || conflict.code === 'LICENSE_BELONGS_TO_ANOTHER_DRIVER' ? 'DUPLICATE' : 'CONFLICT',
          severity: 'HARD',
          code: conflict.code,
        })),
        ...internal.consistency.contradictions.map(conflict => ({
          type: 'CONFLICT',
          severity: 'SOFT',
          code: conflict.code,
        })),
      ],
      missingFields: internal.missingRequired,
      warnings: internal.consistency.warnings,
      issuer: issuer || { state: 'PENDING_PARTNER_ACCESS' },
    });

    return {
      verificationId: `kyc_${crypto.randomBytes(12).toString('hex')}`,
      driverId,
      documentId,
      documentType,
      decision: final.decision,
      reasons: final.reasons,
      warnings: final.warnings,
      normalizedFields: internal.normalizedFields,
      uniquenessConflicts: internal.uniquenessConflicts,
      consistency: internal.consistency,
      issuerVerification: issuer || { state: 'PENDING_PARTNER_ACCESS' },
      evaluatedAt: this.now().toISOString(),
    };
  }
}

module.exports = { KycVerificationOrchestrator };
