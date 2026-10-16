'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KycReviewService } = require('../../src/services/kycReviewService');

function fixture() {
  const db = { state: {}, getDb() { return this.state; }, saveDb() {} };
  return new KycReviewService({ db, now: () => new Date('2026-10-16T10:00:00.000Z') });
}

test('review cases are deduplicated while open', () => {
  const service = fixture();
  const a = service.createCase({ driverId: 'd1', documentId: 'doc1', verificationId: 'v1', decision: 'HUMAN_REVIEW', reasons: ['COPY'] });
  const b = service.createCase({ driverId: 'd1', documentId: 'doc1', verificationId: 'v2', decision: 'HUMAN_REVIEW', reasons: ['OTHER'] });
  assert.equal(a.id, b.id);
});

test('review resolution requires reviewer identity and valid terminal decision', () => {
  const service = fixture();
  const item = service.createCase({ driverId: 'd1', documentId: 'doc1', verificationId: 'v1', decision: 'HUMAN_REVIEW' });
  assert.throws(() => service.resolveCase({ caseId: item.id, reviewerId: 'ops-1', decision: 'VERIFIED', reason: 'approved' }), /KYC review case/);
  const resolved = service.resolveCase({ caseId: item.id, reviewerId: 'ops-1', decision: 'REJECTED', reason: 'document is a self-created paper' });
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.finalDecision, 'REJECTED');
  assert.equal(resolved.resolvedBy, 'ops-1');
  assert.equal(service.db.state.kyc_review_decisions.length, 1);
});

test('resolved cases cannot be changed again', () => {
  const service = fixture();
  const item = service.createCase({ driverId: 'd1', documentId: 'doc1', verificationId: 'v1', decision: 'HUMAN_REVIEW' });
  service.resolveCase({ caseId: item.id, reviewerId: 'ops-1', decision: 'RETAKE', reason: 'better capture required' });
  assert.throws(() => service.resolveCase({ caseId: item.id, reviewerId: 'ops-2', decision: 'VERIFIED' }), /already resolved/);
});
