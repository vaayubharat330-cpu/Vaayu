'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKycReviewRoutes } = require('../../src/http/kycReviewRoutes');

function setup() {
  const state = {
    kyc_review_cases: [{ id: 'case-1', driverId: 'd1', documentId: 'doc-1', verificationId: 'v1', status: 'OPEN', sourceDecision: 'HUMAN_REVIEW', reasons: ['SCREEN_CAPTURE'], createdAt: '2026-10-16T10:00:00.000Z' }],
    kyc_review_decisions: [],
    driver_documents: [{ id: 'doc-1', driverId: 'd1', docType: 'DRIVING_LICENSE', status: 'PENDING' }],
    driver_profiles: [{ id: 'd1', name: 'Driver One', kycStatus: 'PENDING' }]
  };
  const db = {
    getDb: () => state,
    getDriverDocuments: id => state.driver_documents.filter(d => !id || d.driverId === id),
    updateDriverDocument: (id, patch) => Object.assign(state.driver_documents.find(d => d.id === id), patch),
    updateDriverKyc: (id, status) => Object.assign(state.driver_profiles.find(d => d.id === id), { kycStatus: status }),
    updateKycStep: () => {},
    saveDb: () => {}
  };
  const route = createKycReviewRoutes({
    db,
    enforceSecurityChecks: async (_req, _res) => true,
    parseJsonBody: (_res, body) => JSON.parse(body),
    websocketService: { broadcastToRoom: () => {} }
  });
  return { route, state };
}

function response() {
  return {
    headers: {},
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); },
    end(body) { this.body = body; }
  };
}

test('review queue returns open cases', async () => {
  const { route } = setup();
  const res = response();
  await route({ method: 'GET', headers: {} }, res, { pathname: '/api/admin/kyc/review-cases', parsedUrl: { query: {} } });
  const payload = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.count, 1);
  assert.equal(payload.cases[0].id, 'case-1');
});

test('review decision resolves case and updates driver KYC projection', async () => {
  const { route, state } = setup();
  const res = response();
  const req = { method: 'POST', headers: {}, user: { id: 'reviewer-1' }, on(event, listener) { if (event === 'data') listener(JSON.stringify({ decision: 'VERIFIED', reason: 'issuer evidence reconciled' })); if (event === 'end') listener(); } };
  await route(req, res, { pathname: '/api/admin/kyc/review-cases/case-1/decision', parsedUrl: { query: {} } });
  const payload = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.case.finalDecision, 'VERIFIED');
  assert.equal(state.kyc_review_cases[0].status, 'RESOLVED');
  assert.equal(state.driver_documents[0].status, 'VERIFIED');
  assert.equal(state.driver_profiles[0].kycStatus, 'APPROVED');
});

test('second decision is rejected as a conflict', async () => {
  const { route } = setup();
  const first = response();
  const req = { method: 'POST', headers: {}, user: { id: 'reviewer-1' }, on(event, listener) { if (event === 'data') listener(JSON.stringify({ decision: 'RETAKE' })); if (event === 'end') listener(); } };
  await route(req, first, { pathname: '/api/admin/kyc/review-cases/case-1/decision', parsedUrl: { query: {} } });
  const second = response();
  await route(req, second, { pathname: '/api/admin/kyc/review-cases/case-1/decision', parsedUrl: { query: {} } });
  assert.equal(second.statusCode, 409);
});
