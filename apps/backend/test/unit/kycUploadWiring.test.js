'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const routePath = path.resolve(__dirname, '../../src/http/driverPartnerRoutes.js');
const source = fs.readFileSync(routePath, 'utf8');

test('document upload is wired to the KYC verification orchestrator', () => {
  assert.match(source, /KycVerificationOrchestrator/);
  assert.match(source, /new KycVerificationOrchestrator\(\{ db \}\)/);
  assert.match(source, /kycOrchestrator\.evaluate\(/);
  assert.match(source, /documentType = String\(data\.document_type \|\| data\.doc_type/);
  assert.match(source, /data\.kycVerification = verification/);
  assert.match(source, /data\.kycStatus = verification\.decision/);
});

test('hard KYC outcomes prevent persistence of rejected or retake documents', () => {
  assert.match(source, /verification\.decision === 'REJECTED' \|\| verification\.decision === 'RETAKE'/);
  assert.match(source, /fs\.unlinkSync\(path\.join\(PRIVATE_DRIVER_DOCUMENTS/);
});
