'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KycVerificationPersistence, hashIdentity } = require('../../src/services/kycVerificationPersistence');

function transactionalPool() {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('SELECT * FROM driver_kyc_documents')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO driver_kyc_documents')) return { rowCount: 1, rows: [{ kyc_document_id: params[0], decision: params[4] }] };
      return { rowCount: 1, rows: [{ history_id: 1 }] };
    }
  };
  return { queries, async withTransaction(work) { return work(client); } };
}

test('identity hashing is deterministic and never stores plaintext', () => {
  assert.equal(hashIdentity('ts 09 ab 1234'), hashIdentity('TS09AB1234'));
  assert.equal(hashIdentity(''), null);
  assert.equal(hashIdentity(null), null);
});

test('verification persistence writes document, decision history and immutable run in one transaction', async () => {
  const pool = transactionalPool();
  const service = new KycVerificationPersistence({ pool });
  const result = await service.persistEvaluation({
    verificationId: 'kyc_run_1',
    kycDocumentId: 'kyc_doc_1',
    driverId: 'driver_1',
    documentId: 'doc_1',
    documentType: 'RC',
    decision: 'PENDING_PARTNER_ACCESS',
    normalizedFields: { vehicleNumber: 'TS09AB1234', ownerName: 'TEST DRIVER' },
    issuerVerification: { state: 'PENDING_PARTNER_ACCESS', provider: null },
    reasons: ['AUTHORITATIVE_VERIFICATION_UNAVAILABLE'],
    warnings: [],
    captureGate: { decision: 'PASS' },
    consistency: { warnings: [], contradictions: [] }
  });

  assert.equal(result.success, true);
  assert.equal(result.verificationId, 'kyc_run_1');
  assert.equal(pool.queries.filter(q => q.sql.includes('INSERT INTO driver_kyc_documents')).length, 1);
  assert.equal(pool.queries.filter(q => q.sql.includes('INSERT INTO driver_kyc_decision_history')).length, 1);
  assert.equal(pool.queries.filter(q => q.sql.includes('INSERT INTO driver_kyc_verification_runs')).length, 1);
  const documentInsert = pool.queries.find(q => q.sql.includes('INSERT INTO driver_kyc_documents'));
  // The durable document projection must never retain a plaintext vehicle identity.
  assert.equal(documentInsert.params[8], hashIdentity('TS09AB1234'));
  assert.notEqual(documentInsert.params[8], 'TS09AB1234');
});

test('unique identity conflicts are normalized to a domain error', async () => {
  const pool = {
    async withTransaction() {
      const error = new Error('duplicate key');
      error.code = '23505';
      throw error;
    }
  };
  const service = new KycVerificationPersistence({ pool });
  await assert.rejects(
    service.persistEvaluation({ driverId: 'd', documentId: 'x', documentType: 'RC', decision: 'VERIFIED', normalizedFields: {} }),
    (error) => error.code === 'KYC_IDENTITY_CONFLICT'
  );
});
