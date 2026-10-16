'use strict';

/**
 * Enterprise KYC decision engine.
 *
 * Important invariant: no single weak signal can manufacture a VERIFIED result.
 * OCR, handwriting detection, image quality, duplicate checks and ML signals
 * are evidence. Issuer verification is authoritative where required.
 */

const DECISIONS = Object.freeze({
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  RETAKE: 'RETAKE',
  HUMAN_REVIEW: 'HUMAN_REVIEW',
  PENDING_PARTNER_ACCESS: 'PENDING_PARTNER_ACCESS',
});

const REJECTION_CODES = Object.freeze({
  HANDWRITTEN_CONTENT: 'HANDWRITTEN_CONTENT',
  DOCUMENT_NOT_DETECTED: 'DOCUMENT_NOT_DETECTED',
  IMAGE_TOO_POOR: 'IMAGE_TOO_POOR',
  DUPLICATE_DOCUMENT: 'DUPLICATE_DOCUMENT',
  IDENTITY_CONFLICT: 'IDENTITY_CONFLICT',
  ISSUER_REJECTED: 'ISSUER_REJECTED',
  EXPIRED_DOCUMENT: 'EXPIRED_DOCUMENT',
  CROSS_DOCUMENT_CONFLICT: 'CROSS_DOCUMENT_CONFLICT',
  FRAUD_SIGNAL: 'FRAUD_SIGNAL',
});

function decide(input = {}) {
  const signals = input.signals || {};
  const issuer = input.issuer || {};
  const conflicts = Array.isArray(input.conflicts) ? input.conflicts : [];
  const missing = Array.isArray(input.missingFields) ? input.missingFields : [];
  const warnings = Array.isArray(input.warnings) ? input.warnings : [];

  const hardReject = [];
  const retake = [];
  const review = [];

  // Handwriting is explicitly a hard fraud/invalid-capture signal for
  // identity/vehicle documents. A handwritten number is not an acceptable
  // substitute for an issuer document.
  if (signals.handwrittenLikely === true) hardReject.push(REJECTION_CODES.HANDWRITTEN_CONTENT);
  if (signals.documentLike === false) hardReject.push(REJECTION_CODES.DOCUMENT_NOT_DETECTED);
  if (signals.fraudSignal === true) hardReject.push(REJECTION_CODES.FRAUD_SIGNAL);

  if (signals.imageQuality === 'FAIL') retake.push(REJECTION_CODES.IMAGE_TOO_POOR);
  if (signals.imageQuality === 'RETAKE') retake.push(REJECTION_CODES.IMAGE_TOO_POOR);

  for (const conflict of conflicts) {
    if (conflict.severity === 'HARD' || conflict.type === 'DUPLICATE') {
      hardReject.push(conflict.code || REJECTION_CODES.DUPLICATE_DOCUMENT);
    } else {
      review.push(conflict.code || REJECTION_CODES.CROSS_DOCUMENT_CONFLICT);
    }
  }

  if (issuer.state === 'VERIFIED_REJECTED') hardReject.push(REJECTION_CODES.ISSUER_REJECTED);

  if (hardReject.length) {
    return { decision: DECISIONS.REJECTED, reasons: [...new Set(hardReject)], warnings };
  }

  if (retake.length || missing.length > 0 && signals.documentLike !== true) {
    return { decision: DECISIONS.RETAKE, reasons: [...new Set(retake.length ? retake : [REJECTION_CODES.DOCUMENT_NOT_DETECTED])], warnings };
  }

  if (review.length || signals.syntheticOrEditedLikely === true || signals.copyLikely === true) {
    return { decision: DECISIONS.HUMAN_REVIEW, reasons: [...new Set(review.length ? review : [REJECTION_CODES.FRAUD_SIGNAL])], warnings };
  }

  if (issuer.state === 'VERIFIED_MATCH') {
    return { decision: DECISIONS.VERIFIED, reasons: [], warnings };
  }

  if (issuer.state === 'PENDING_PARTNER_ACCESS' || issuer.state === 'UNAVAILABLE' || !issuer.state) {
    return {
      decision: DECISIONS.PENDING_PARTNER_ACCESS,
      reasons: ['AUTHORITATIVE_VERIFICATION_UNAVAILABLE'],
      warnings,
    };
  }

  return { decision: DECISIONS.HUMAN_REVIEW, reasons: ['UNCLASSIFIED_VERIFICATION_STATE'], warnings };
}

module.exports = { DECISIONS, REJECTION_CODES, decide };
