'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, DECISIONS, REJECTION_CODES } = require('../../src/services/documentVerificationDecisionEngine');

test('handwritten government-document numbers are rejected', () => {
  const result = decide({
    signals: { handwrittenLikely: true, documentLike: true, imageQuality: 'PASS' },
    issuer: { state: 'VERIFIED_MATCH' },
  });
  assert.equal(result.decision, DECISIONS.REJECTED);
  assert.ok(result.reasons.includes(REJECTION_CODES.HANDWRITTEN_CONTENT));
});

test('poor capture requests a retake rather than accepting weak evidence', () => {
  const result = decide({
    signals: { documentLike: true, imageQuality: 'RETAKE' },
    issuer: { state: 'VERIFIED_MATCH' },
  });
  assert.equal(result.decision, DECISIONS.RETAKE);
});

test('duplicate identity conflict is rejected even if issuer says match', () => {
  const result = decide({
    signals: { documentLike: true, imageQuality: 'PASS' },
    conflicts: [{ type: 'DUPLICATE', severity: 'HARD', code: 'DL_ALREADY_BOUND_TO_OTHER_DRIVER' }],
    issuer: { state: 'VERIFIED_MATCH' },
  });
  assert.equal(result.decision, DECISIONS.REJECTED);
});

test('issuer match is required before VERIFIED', () => {
  const result = decide({
    signals: { documentLike: true, imageQuality: 'PASS' },
    issuer: { state: 'UNAVAILABLE' },
  });
  assert.equal(result.decision, DECISIONS.PENDING_PARTNER_ACCESS);
});

test('edited or synthetic-looking evidence is routed to human review', () => {
  const result = decide({
    signals: { documentLike: true, imageQuality: 'PASS', syntheticOrEditedLikely: true },
    issuer: { state: 'VERIFIED_MATCH' },
  });
  assert.equal(result.decision, DECISIONS.HUMAN_REVIEW);
});
