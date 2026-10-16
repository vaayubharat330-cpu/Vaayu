'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KycVerificationOrchestrator } = require('../../src/services/kycVerificationOrchestrator');

test('KYC orchestration never promotes OCR-only evidence to VERIFIED', async () => {
  const db = { getDb: () => ({ driver_documents: [] }) };
  const providerRegistry = { verify: async () => ({ state: 'PENDING_PARTNER_ACCESS', provider: null }) };
  const orchestrator = new KycVerificationOrchestrator({ db, providerRegistry });
  const result = await orchestrator.evaluate({
    driverId: 'driver-1', documentId: 'doc-1', documentType: 'RC',
    fields: { vehicleNumber: 'TS09AB1234', ownerName: 'TEST DRIVER' },
    signals: { documentLike: true, imageQuality: 'PASS' },
  });
  assert.equal(result.decision, 'PENDING_PARTNER_ACCESS');
});

test('KYC orchestration rejects a duplicate before issuer acceptance', async () => {
  const db = { getDb: () => ({ driver_documents: [{
    id: 'doc-old', driverId: 'driver-other', documentType: 'RC',
    extractedFields: { vehicleNumber: 'TS09AB1234', ownerName: 'OTHER' },
  }] }) };
  const providerRegistry = { verify: async () => ({ state: 'VERIFIED_MATCH', provider: 'TEST' }) };
  const orchestrator = new KycVerificationOrchestrator({ db, providerRegistry });
  const result = await orchestrator.evaluate({
    driverId: 'driver-new', documentId: 'doc-new', documentType: 'RC',
    fields: { vehicleNumber: 'TS09AB1234', ownerName: 'TEST DRIVER' },
    signals: { documentLike: true, imageQuality: 'PASS' },
  });
  assert.equal(result.decision, 'REJECTED');
});

test('same driving licence may be reused by the same driver across vehicles', async () => {
  const db = { getDb: () => ({ driver_documents: [{
    id: 'dl-old', driverId: 'driver-1', documentType: 'DRIVING_LICENSE',
    extractedFields: { licenseNumber: 'DL1234567890', name: 'TEST DRIVER' },
  }] }) };
  const providerRegistry = { verify: async () => ({ state: 'VERIFIED_MATCH', provider: 'TEST' }) };
  const orchestrator = new KycVerificationOrchestrator({ db, providerRegistry });
  const result = await orchestrator.evaluate({
    driverId: 'driver-1', documentId: 'dl-new', documentType: 'DRIVING_LICENSE',
    fields: { licenseNumber: 'DL1234567890', name: 'TEST DRIVER' },
    signals: { documentLike: true, imageQuality: 'PASS' },
  });
  assert.equal(result.decision, 'VERIFIED');
});

test('handwritten content is rejected before any issuer request is made', async () => {
  const db = { getDb: () => ({ driver_documents: [] }) };
  let providerCalls = 0;
  const providerRegistry = { verify: async () => { providerCalls += 1; return { state: 'VERIFIED_MATCH' }; } };
  const orchestrator = new KycVerificationOrchestrator({ db, providerRegistry });
  const result = await orchestrator.evaluate({
    driverId: 'driver-1', documentId: 'doc-handwritten', documentType: 'RC',
    fields: { vehicleNumber: 'TS09AB1234', ownerName: 'TEST DRIVER' },
    signals: { documentLike: true, imageQuality: 'PASS', handwrittenLikely: true },
  });
  assert.equal(result.decision, 'REJECTED');
  assert.equal(providerCalls, 0);
  assert.ok(result.reasons.includes('HANDWRITTEN_CONTENT'));
});

test('screen captures are routed to human review before issuer verification', async () => {
  const db = { getDb: () => ({ driver_documents: [] }) };
  let providerCalls = 0;
  const providerRegistry = { verify: async () => { providerCalls += 1; return { state: 'VERIFIED_MATCH' }; } };
  const orchestrator = new KycVerificationOrchestrator({ db, providerRegistry });
  const result = await orchestrator.evaluate({
    driverId: 'driver-1', documentId: 'doc-screen', documentType: 'DRIVING_LICENSE',
    fields: { licenseNumber: 'DL1234567890', name: 'TEST DRIVER' },
    signals: { documentLike: true, imageQuality: 'PASS', screenCaptureLikely: true },
  });
  assert.equal(result.decision, 'HUMAN_REVIEW');
  assert.equal(providerCalls, 0);
  assert.ok(result.reasons.includes('SCREEN_CAPTURE'));
});
