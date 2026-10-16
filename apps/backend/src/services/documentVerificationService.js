const crypto = require('crypto');

/**
 * Deterministic document verification policy.
 *
 * This service deliberately separates three questions:
 *  1. Is the captured value structurally plausible?
 *  2. Is the value already owned by another VAAYU account?
 *  3. Can an authoritative issuer verify the document?
 *
 * A readable OCR result is never treated as proof that a government document is
 * genuine. Official verification is an independent signal and may be unavailable
 * until VAAYU is onboarded with the issuer/partner API.
 */

const RULES = Object.freeze({
  VEHICLE_PHOTO: {
    identityFields: ['vehicleNumber'],
    globallyUnique: ['vehicleNumber'],
    sameOwnerAllowed: [],
    requiredForAutoApproval: ['vehicleNumber']
  },
  RC: {
    identityFields: ['vehicleNumber', 'chassisLast5', 'engineLast5'],
    globallyUnique: ['vehicleNumber', 'chassisLast5', 'engineLast5'],
    sameOwnerAllowed: [],
    requiredForAutoApproval: ['vehicleNumber', 'ownerName']
  },
  DRIVING_LICENSE: {
    identityFields: ['licenseNumber'],
    globallyUnique: [],
    sameOwnerAllowed: ['licenseNumber'],
    uniqueToDifferentPerson: ['licenseNumber'],
    requiredForAutoApproval: ['licenseNumber', 'name']
  },
  INSURANCE: {
    identityFields: ['policyNumber', 'vehicleNumber'],
    globallyUnique: ['policyNumber'],
    sameOwnerAllowed: [],
    requiredForAutoApproval: ['policyNumber', 'vehicleNumber']
  },
  PAN: {
    identityFields: ['panNumber'],
    globallyUnique: ['panNumber'],
    sameOwnerAllowed: [],
    requiredForAutoApproval: ['panNumber', 'name']
  },
  AADHAAR: {
    // Full Aadhaar is intentionally not stored in the current mobile flow, so
    // last-four alone is NOT a uniqueness key and can never cause rejection.
    identityFields: ['aadhaarLast4'],
    globallyUnique: [],
    sameOwnerAllowed: ['aadhaarLast4'],
    requiredForAutoApproval: ['name']
  },
  PROFILE_PHOTO: {
    identityFields: [],
    globallyUnique: [],
    sameOwnerAllowed: [],
    requiredForAutoApproval: []
  }
});

function normalizeField(key, value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim().toUpperCase();
  if (['vehicleNumber', 'licenseNumber', 'policyNumber', 'panNumber', 'chassisLast5', 'engineLast5'].includes(key)) {
    return raw.replace(/[^A-Z0-9]/g, '');
  }
  return raw.replace(/\s+/g, ' ');
}

function normalizeFields(fields = {}) {
  const result = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const normalized = normalizeField(key, value);
    if (normalized) result[key] = normalized;
  }
  return result;
}

function getRules(documentType) {
  return RULES[documentType] || RULES.PROFILE_PHOTO;
}

function getDocuments(db) {
  const store = db && typeof db.getDb === 'function' ? db.getDb() : {};
  return Array.isArray(store.driver_documents) ? store.driver_documents : [];
}

function getStoredFields(document) {
  return normalizeFields(document?.extractedFields || document?.extraction?.fields || {});
}

/**
 * Checks VAAYU's own registry before a document is accepted.
 *
 * Vehicle registration/RC identity is global: the same vehicle cannot be
 * registered to two driver accounts. A DL is person-bound rather than vehicle-
 * bound: the same driver's DL may appear on multiple vehicle records, but the
 * same DL cannot be attached to a different driver account.
 */
function checkInternalUniqueness({ db, driverId, documentType, fields, currentDocumentId = null }) {
  const normalized = normalizeFields(fields);
  const rules = getRules(documentType);
  const conflicts = [];
  const documents = getDocuments(db);

  for (const existing of documents) {
    if (String(existing.id) === String(currentDocumentId)) continue;
    const existingFields = getStoredFields(existing);
    const existingDriverId = String(existing.driverId || existing.driver_id || '');
    const sameDriver = existingDriverId && existingDriverId === String(driverId);
    const existingType = String(existing.docType || existing.documentType || '').toUpperCase();

    for (const key of rules.globallyUnique) {
      const value = normalized[key];
      if (!value || existingFields[key] !== value) continue;
      conflicts.push({
        code: 'IDENTITY_ALREADY_REGISTERED',
        field: key,
        value: maskSensitiveValue(key, value),
        existingDocumentId: existing.id,
        existingDriverId,
        sameDriver,
        existingType,
        message: key === 'vehicleNumber'
          ? 'This vehicle registration number is already registered in VAAYU.'
          : key === 'chassisLast5'
            ? 'This vehicle chassis identity is already registered in VAAYU.'
            : key === 'engineLast5'
              ? 'This engine identity is already registered in VAAYU.'
              : key === 'policyNumber'
                ? 'This insurance policy is already registered in VAAYU.'
                : 'This identity document is already registered in VAAYU.'
      });
    }

    for (const key of rules.uniqueToDifferentPerson || []) {
      const value = normalized[key];
      if (!value || existingFields[key] !== value || sameDriver) continue;
      conflicts.push({
        code: 'LICENSE_BELONGS_TO_ANOTHER_DRIVER',
        field: key,
        value: maskSensitiveValue(key, value),
        existingDocumentId: existing.id,
        existingDriverId,
        sameDriver,
        existingType,
        message: 'This driving licence number is already associated with another VAAYU driver account.'
      });
    }
  }

  // Deduplicate conflicts because the same identity may be present in multiple
  // historical documents belonging to the same account.
  const seen = new Set();
  return conflicts.filter(conflict => {
    const key = `${conflict.code}:${conflict.field}:${conflict.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function maskSensitiveValue(field, value) {
  if (!value) return '';
  if (field === 'licenseNumber' || field === 'policyNumber' || field === 'panNumber') {
    return value.length <= 4 ? '****' : `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  if (field === 'chassisLast5' || field === 'engineLast5') return `***${value.slice(-2)}`;
  return value;
}

function validateCrossDocumentConsistency({ db, driverId, fields }) {
  const normalized = normalizeFields(fields);
  const documents = getDocuments(db).filter(d => String(d.driverId || d.driver_id || '') === String(driverId));
  const all = documents.map(getStoredFields);
  const warnings = [];
  const contradictions = [];

  const vehicleNumbers = new Set(all.map(f => f.vehicleNumber).filter(Boolean));
  if (normalized.vehicleNumber && vehicleNumbers.size && !vehicleNumbers.has(normalized.vehicleNumber)) {
    warnings.push('The captured vehicle number differs from a previously submitted vehicle number for this driver.');
  }

  const names = all.map(f => f.ownerName || f.name).filter(Boolean);
  if (normalized.name && names.length) {
    const normalizedName = normalized.name.replace(/[^A-Z0-9]/g, '');
    const close = names.some(name => {
      const other = normalizeField('name', name).replace(/[^A-Z0-9]/g, '');
      return other === normalizedName || other.includes(normalizedName) || normalizedName.includes(other);
    });
    if (!close) contradictions.push({ code: 'NAME_MISMATCH', message: 'The document name does not match previously submitted identity information.' });
  }

  return { warnings, contradictions };
}

function evaluateDocument({ db, driverId, documentType, fields, currentDocumentId = null, officialVerification = null }) {
  const normalizedFields = normalizeFields(fields);
  const rules = getRules(documentType);
  const missingRequired = (rules.requiredForAutoApproval || []).filter(key => !normalizedFields[key]);
  const uniquenessConflicts = checkInternalUniqueness({ db, driverId, documentType, fields: normalizedFields, currentDocumentId });
  const consistency = validateCrossDocumentConsistency({ db, driverId, fields: normalizedFields });

  const official = officialVerification || { status: 'NOT_CONFIGURED', source: null, checkedAt: null, matches: null };
  const hardReject = uniquenessConflicts.length > 0;
  const officialReject = official.status === 'VERIFIED_REJECTED' || official.matches === false;
  const missingOfficial = official.status === 'NOT_CONFIGURED' || official.status === 'UNAVAILABLE' || official.status === 'PENDING_PARTNER_ACCESS';

  let decision = 'NEEDS_REVIEW';
  if (hardReject || officialReject) decision = 'REJECTED';
  else if (documentType === 'PROFILE_PHOTO') decision = 'PENDING_REVIEW';
  else if (missingRequired.length) decision = 'NEEDS_REVIEW';
  else if (consistency.contradictions.length) decision = 'NEEDS_REVIEW';
  else if (official.status === 'VERIFIED_MATCH' && !consistency.contradictions.length) decision = 'VERIFIED';

  return {
    decision,
    documentType,
    normalizedFields,
    missingRequired,
    uniquenessConflicts,
    consistency,
    officialVerification: official,
    authenticity: {
      officialSourceVerified: official.status === 'VERIFIED_MATCH',
      imageTextStructurallyValid: missingRequired.length === 0,
      authenticityStatus: official.status === 'VERIFIED_MATCH' ? 'OFFICIAL_SOURCE_MATCH' : 'NOT_PROVEN'
    },
    verificationId: `dv_${crypto.randomBytes(12).toString('hex')}`,
    evaluatedAt: new Date().toISOString()
  };
}

module.exports = {
  RULES,
  normalizeFields,
  maskSensitiveValue,
  checkInternalUniqueness,
  validateCrossDocumentConsistency,
  evaluateDocument
};
