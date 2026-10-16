'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateExpiry, findExpiredDocuments } = require('../../src/services/kycExpiryService');

test('verified expired driving licence requires reverification', () => {
  const result = evaluateExpiry({ documentType: 'DRIVING_LICENSE', decision: 'VERIFIED', expiresAt: '2026-01-01T00:00:00Z' }, new Date('2026-02-01T00:00:00Z'));
  assert.equal(result.action, 'REVERIFY_REQUIRED');
  assert.equal(result.nextDecision, 'HUMAN_REVIEW');
});

test('active insurance remains valid before expiry', () => {
  const result = evaluateExpiry({ documentType: 'INSURANCE', decision: 'VERIFIED', expiresAt: '2026-03-01T00:00:00Z' }, new Date('2026-02-01T00:00:00Z'));
  assert.equal(result.action, 'ACTIVE');
  assert.equal(result.expired, false);
});

test('expiry scan only returns documents requiring reverification', () => {
  const result = findExpiredDocuments([
    { id: '1', documentType: 'RC', decision: 'VERIFIED', expiresAt: '2025-01-01T00:00:00Z' },
    { id: '2', documentType: 'RC', decision: 'REJECTED', expiresAt: '2025-01-01T00:00:00Z' },
  ], new Date('2026-01-01T00:00:00Z'));
  assert.deepEqual(result.map(item => item.document.id), ['1']);
});
