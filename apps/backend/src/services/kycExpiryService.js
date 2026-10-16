'use strict';

/**
 * KYC lifecycle policy for expiring documents.
 *
 * Expiry never silently deletes a driver's identity. It moves an otherwise
 * verified document back into a controlled review state so dispatch policy can
 * refuse use of expired credentials.
 */

const EXPIRY_SENSITIVE_TYPES = new Set([
  'DRIVING_LICENSE',
  'RC',
  'INSURANCE',
  'PAN',
  'AADHAAR',
]);

function evaluateExpiry(document, now = new Date()) {
  if (!document || !document.expiresAt) return { expired: false, action: 'NO_EXPIRY' };
  const expiry = new Date(document.expiresAt);
  if (Number.isNaN(expiry.getTime())) return { expired: false, action: 'INVALID_EXPIRY', requiresReview: true };
  if (!EXPIRY_SENSITIVE_TYPES.has(String(document.documentType || '').toUpperCase())) return { expired: false, action: 'NOT_EXPIRY_GOVERNED' };
  if (expiry.getTime() >= now.getTime()) return { expired: false, action: 'ACTIVE' };
  if (document.decision !== 'VERIFIED') return { expired: true, action: 'EXPIRED_NON_VERIFIED', requiresReview: false };
  return { expired: true, action: 'REVERIFY_REQUIRED', requiresReview: true, nextDecision: 'HUMAN_REVIEW' };
}

function findExpiredDocuments(documents = [], now = new Date()) {
  return documents
    .map(document => ({ document, expiry: evaluateExpiry(document, now) }))
    .filter(item => item.expiry.expired && item.expiry.requiresReview);
}

module.exports = { EXPIRY_SENSITIVE_TYPES, evaluateExpiry, findExpiredDocuments };
