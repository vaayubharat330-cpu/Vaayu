'use strict';

const crypto = require('crypto');
const { evaluateDocument } = require('./documentVerificationService');
const { buildDefaultProviderRegistry } = require('./documentVerificationProviders');
const { evaluateCapture, DOCUMENT_CAPTURE_DECISIONS } = require('./documentCapturePolicy');
const { decide } = require('./documentVerificationDecisionEngine');

/**
 * Single orchestration boundary for KYC.
 *
 * Ordering is intentional:
 *   capture quality/fraud gate -> VAAYU identity rules -> issuer verification -> final decision
 *
 * No OCR result is ever treated as authenticity proof.
 */
class KycVerificationOrchestrator {
  constructor({ db, providerRegistry = null, now = () => new Date() } = {}) {
    this.db = db;
    this.providerRegistry = providerRegistry || buildDefaultProviderRegistry();
    this.now = now;
  }

  async evaluate({ driverId, documentId, documentType, fields, signals = {}, officialVerification = null }) {
    const capture = evaluateCapture(signals);

    // Do not spend issuer/API quota on an obviously invalid capture. This also
    // guarantees that handwritten/self-created documents cannot become VERIFIED
    // because a provider happens to match an OCR'd number.
    if (capture.decision === DOCUMENT_CAPTURE_DECISIONS.REJECT ||
        capture.decision === DOCUMENT_CAPTURE_DECISIONS.RETAKE ||
        capture.decision === DOCUMENT_CAPTURE_DECISIONS.REVIEW) {
      return {
        verificationId: `kyc_${crypto.randomBytes(12).toString('hex')}`,
        driverId,
        documentId,
        documentType,
        decision: capture.decision === DOCUMENT_CAPTURE_DECISIONS.REJECT ? 'REJECTED'
          : capture.decision === DOCUMENT_CAPTURE_DECISIONS.RETAKE ? 'RETAKE'
            : 'HUMAN_REVIEW',
        reasons: capture.reasons,
        warnings: capture.warnings,
        captureGate: capture,
        normalizedFields: {},
        uniquenessConflicts: [],
        consistency: { warnings: [], contradictions: [] },
        issuerVerification: { state: 'NOT_ATTEMPTED_CAPTURE_GATE' },
        evaluatedAt: this.now().toISOString(),
      };
    }

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
      warnings: [...capture.warnings, ...internal.consistency.warnings],
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
      captureGate: capture,
      normalizedFields: internal.normalizedFields,
      uniquenessConflicts: internal.uniquenessConflicts,
      consistency: internal.consistency,
      issuerVerification: issuer || { state: 'PENDING_PARTNER_ACCESS' },
      evaluatedAt: this.now().toISOString(),
    };
  }
}

module.exports = { KycVerificationOrchestrator };
