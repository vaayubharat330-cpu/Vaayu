'use strict';

const crypto = require('crypto');
const { isSha256 } = require('./kycPrivacyPolicy');

function assertEvidenceHash(value) {
  if (value == null || value === '') return null;
  if (!isSha256(value)) {
    const error = new Error('KYC evidenceHash must be a SHA-256 hex digest');
    error.code = 'KYC_EVIDENCE_HASH_INVALID';
    throw error;
  }
  return value.toLowerCase();
}

class KycReviewService {
  constructor({ db, now = () => new Date() } = {}) {
    this.db = db;
    this.now = now;
  }

  _store() {
    const store = this.db.getDb ? this.db.getDb() : null;
    if (!store) throw new Error('KYC persistence store unavailable');
    if (!Array.isArray(store.kyc_review_cases)) store.kyc_review_cases = [];
    if (!Array.isArray(store.kyc_review_decisions)) store.kyc_review_decisions = [];
    return store;
  }

  createCase({ driverId, documentId, verificationId, decision, reasons = [], evidenceHash = null }) {
    const store = this._store();
    const existing = store.kyc_review_cases.find(c => c.documentId === documentId && c.status === 'OPEN');
    if (existing) return existing;
    const now = this.now().toISOString();
    const item = {
      id: `kyc_review_${crypto.randomBytes(12).toString('hex')}`,
      driverId,
      documentId,
      verificationId,
      sourceDecision: decision,
      reasons: [...new Set(reasons)].slice(0, 20),
      evidenceHash: assertEvidenceHash(evidenceHash),
      status: 'OPEN',
      createdAt: now,
      updatedAt: now,
    };
    store.kyc_review_cases.push(item);
    if (typeof this.db.saveDb === 'function') this.db.saveDb(store);
    return item;
  }

  resolveCase({ caseId, reviewerId, decision, reason, evidenceHash = null }) {
    if (!['VERIFIED', 'REJECTED', 'RETAKE'].includes(decision)) {
      const error = new Error('Invalid KYC review decision');
      error.code = 'INVALID_KYC_REVIEW_DECISION';
      throw error;
    }
    if (!reviewerId) {
      const error = new Error('Reviewer identity is required');
      error.code = 'REVIEWER_ID_REQUIRED';
      throw error;
    }
    const store = this._store();
    const item = store.kyc_review_cases.find(c => c.id === caseId);
    if (!item) {
      const error = new Error('KYC review case not found');
      error.code = 'KYC_REVIEW_NOT_FOUND';
      throw error;
    }
    if (item.status !== 'OPEN') {
      const error = new Error('KYC review case is already resolved');
      error.code = 'KYC_REVIEW_ALREADY_RESOLVED';
      throw error;
    }
    const normalizedEvidenceHash = assertEvidenceHash(evidenceHash);
    const timestamp = this.now().toISOString();
    item.status = 'RESOLVED';
    item.finalDecision = decision;
    item.resolvedBy = reviewerId;
    item.resolutionReason = String(reason || '').trim().slice(0, 1000);
    item.resolutionEvidenceHash = normalizedEvidenceHash || item.evidenceHash || null;
    item.resolvedAt = timestamp;
    item.updatedAt = timestamp;
    store.kyc_review_decisions.push({
      id: `kyc_review_decision_${crypto.randomBytes(12).toString('hex')}`,
      caseId,
      driverId: item.driverId,
      documentId: item.documentId,
      reviewerId,
      decision,
      reason: item.resolutionReason,
      evidenceHash: item.resolutionEvidenceHash,
      createdAt: timestamp,
    });
    if (typeof this.db.saveDb === 'function') this.db.saveDb(store);
    return item;
  }
}

module.exports = { KycReviewService, assertEvidenceHash };
