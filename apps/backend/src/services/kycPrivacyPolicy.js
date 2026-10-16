'use strict';

/**
 * KYC privacy boundary for structured OCR/verification fields.
 *
 * The canonical KYC table intentionally keeps stable hashes for identity
 * matching. Provider/OCR projections must not silently turn into a second
 * plaintext identity store. Fields that are useful for operational review
 * remain only when they are non-sensitive or explicitly masked.
 */
const SENSITIVE_FIELD_PATTERNS = [
  /^(owner|applicant|holder)?name$/i,
  /^(license|licence)(number|no|id)?$/i,
  /^(pan)(number|no)?$/i,
  /^aadhaar/i,
  /^phone/i,
  /^mobile/i,
  /^email/i,
  /^address/i,
  /^dob$/i,
  /^dateofbirth$/i,
  /^account(number|no)?$/i,
  /^ifsc$/i,
  /^policy(number|no)?$/i,
  /^chassis(number|no)?$/i,
  /^engine(number|no)?$/i,
  /^vehicle(number|no|registration|reg)?$/i,
];

function isSensitiveField(key) {
  return SENSITIVE_FIELD_PATTERNS.some(pattern => pattern.test(String(key || '')));
}

function maskValue(value) {
  if (value == null) return value;
  const text = String(value);
  if (text.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, text.length - 4))}${text.slice(-4)}`;
}

function sanitizeExtractedFields(fields = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  const output = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isSensitiveField(key)) {
      output[key] = maskValue(value);
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value.map(item => item && typeof item === 'object' ? sanitizeExtractedFields(item) : item);
    } else if (value && typeof value === 'object') {
      output[key] = sanitizeExtractedFields(value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

module.exports = { isSensitiveField, maskValue, sanitizeExtractedFields, isSha256 };
