'use strict';

/**
 * Deterministic capture gate used before issuer verification.
 * This is deliberately conservative: weak/ambiguous captures should be
 * retried or reviewed rather than being treated as authentic documents.
 * It does not claim to replace a trained vision model.
 */

const DOCUMENT_CAPTURE_DECISIONS = Object.freeze({
  ACCEPT: 'ACCEPT',
  RETAKE: 'RETAKE',
  REJECT: 'REJECT',
  REVIEW: 'REVIEW',
});

function evaluateCapture(input = {}) {
  const reasons = [];
  const warnings = [];

  if (input.documentDetected === false) {
    reasons.push('DOCUMENT_NOT_DETECTED');
  }

  if (input.handwrittenLikely === true) {
    reasons.push('HANDWRITTEN_CONTENT');
  }

  if (input.screenCaptureLikely === true) {
    reasons.push('SCREEN_CAPTURE');
  }

  if (input.syntheticOrEditedLikely === true) {
    reasons.push('SYNTHETIC_OR_EDITED_CONTENT');
  }

  if (input.imageQuality === 'FAIL') {
    reasons.push('IMAGE_QUALITY_FAIL');
  } else if (input.imageQuality === 'RETAKE') {
    reasons.push('IMAGE_QUALITY_RETAKE');
  }

  if (Number.isFinite(input.blurScore) && input.blurScore < 0.25) {
    reasons.push('BLUR_TOO_HIGH');
  }

  if (Number.isFinite(input.glareRatio) && input.glareRatio > 0.35) {
    reasons.push('GLARE_TOO_HIGH');
  }

  if (Number.isFinite(input.documentCoverage) && input.documentCoverage < 0.55) {
    reasons.push('DOCUMENT_TOO_SMALL_IN_FRAME');
  }

  if (Number.isFinite(input.documentCoverage) && input.documentCoverage > 0.98) {
    warnings.push('DOCUMENT_NEAR_FRAME_EDGE');
  }

  if (Number.isFinite(input.ocrConfidence) && input.ocrConfidence < 0.45) {
    reasons.push('OCR_CONFIDENCE_TOO_LOW');
  } else if (Number.isFinite(input.ocrConfidence) && input.ocrConfidence < 0.70) {
    warnings.push('OCR_CONFIDENCE_LOW');
  }

  const uniqueReasons = [...new Set(reasons)];

  if (uniqueReasons.includes('HANDWRITTEN_CONTENT') ||
      uniqueReasons.includes('SYNTHETIC_OR_EDITED_CONTENT')) {
    return { decision: DOCUMENT_CAPTURE_DECISIONS.REJECT, reasons: uniqueReasons, warnings };
  }

  if (uniqueReasons.includes('SCREEN_CAPTURE')) {
    return { decision: DOCUMENT_CAPTURE_DECISIONS.REVIEW, reasons: uniqueReasons, warnings };
  }

  if (uniqueReasons.length) {
    return { decision: DOCUMENT_CAPTURE_DECISIONS.RETAKE, reasons: uniqueReasons, warnings };
  }

  return { decision: DOCUMENT_CAPTURE_DECISIONS.ACCEPT, reasons: [], warnings };
}

module.exports = { DOCUMENT_CAPTURE_DECISIONS, evaluateCapture };
