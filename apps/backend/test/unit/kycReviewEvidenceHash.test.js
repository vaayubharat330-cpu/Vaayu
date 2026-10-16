'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KycReviewService } = require('../../src/services/kycReviewService');

function fixture() {
  const db = { state: {}, getDb() { return this.state; }, saveDb() {} };
  return new KycReviewService({ db, now: () => new Date('2026-10-16T10:00:00.000Z') });
}

test('KYC review rejects malformed evidence hashes', () => {
  const service = fixture();
  assert.throws(
    () => service.createCase({ driverId: 'd1', documentId: 'doc1', verificationId: 'v1', decision: 'HUMAN_REVIEW', evidenceHash: 'bad' }),
    error => error.code === 'KYC_EVIDENCE_HASH_INVALID'
  );
});

test('KYC review canonicalizes valid evidence hashes', () => {
  const service = fixture();
  const hash = 'A'.repeat(64);
  const item = service.createCase({ driverId: 'd1', documentId: 'doc1', verificationId: 'v1', decision: 'HUMAN_REVIEW', evidenceHash: hash });
  assert.equal(item.evidenceHash, 'a'.repeat(64));
  const resolved = service.resolveCase({ caseId: item.id, reviewerId: 'ops-1', decision: 'VERIFIED', evidenceHash: hash });
  assert.equal(resolved.resolutionEvidenceHash, 'a'.repeat(64));
});
