'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KycVerificationPersistence, hashIdentity } = require('../../src/services/kycVerificationPersistence');

function fakePool() {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('SELECT * FROM driver_kyc_documents')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO driver_kyc_documents')) return { rowCount: 1, rows: [{ kyc_document_id: params[0], decision: params[4] }] };
      if (sql.includes('INSERT INTO driver_kyc_verification_runs')) return { rowCount: 1, rows: [{ run_id: params[0] }] };
      return { rowCount: 1, rows: [{ history_id: 1 }] };
    }
  };
  return { queries, async withTransaction(work) { return work(client); } };
}

test('KYC persistence hashes vehicle identity and redacts structured identity fields', async () => {
  const pool = fakePool();
  const service = new KycVerificationPersistence({ pool });

  await service.persistEvaluation({
    verificationId: 'run-privacy-1',
    kycDocumentId: 'doc-privacy-1',
    driverId: 'driver-1',
    documentId: 'rc-1',
    documentType: 'RC',
    decision: 'PENDING_PARTNER_ACCESS',
    normalizedFields: {
      vehicleNumber: 'TS09AB1234',
      ownerName: 'TEST DRIVER',
      chassisLast5: 'ABCDE',
      nested: { phone: '9876543210' }
    },
    issuerVerification: { state: 'PENDING_PARTNER_ACCESS' }
  });

  const insert = pool.queries.find(q => q.sql.includes('INSERT INTO driver_kyc_documents'));
  const extractedFields = JSON.parse(insert.params[18]);
  assert.equal(insert.params[8], hashIdentity('TS09AB1234'));
  assert.equal(insert.params[8].length, 64);
  assert.notEqual(insert.params[8], 'TS09AB1234');
  assert.equal(extractedFields.ownerName, '*******IVER');
  assert.equal(extractedFields.vehicleNumber, '******1234');
  assert.equal(extractedFields.chassisLast5, '****BCDE');
  assert.equal(extractedFields.nested.phone, '******3210');
});

test('KYC persistence rejects malformed evidence hashes before opening a transaction', async () => {
  let transactionCalled = false;
  const pool = { async withTransaction() { transactionCalled = true; } };
  const service = new KycVerificationPersistence({ pool });

  await assert.rejects(
    service.persistEvaluation({
      driverId: 'driver-1',
      documentId: 'doc-1',
      documentType: 'RC',
      decision: 'PENDING_PARTNER_ACCESS',
      evidenceHash: 'bad-hash'
    }),
    error => error.code === 'KYC_EVIDENCE_HASH_INVALID'
  );
  assert.equal(transactionCalled, false);
});
