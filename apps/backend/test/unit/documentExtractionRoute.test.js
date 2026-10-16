const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProofRoutes } = require('../../src/http/proofRoutes');

function makeReq(body) {
  const req = new EventEmitter();
  req.user = { id: 'user_driver_1', role: 'DRIVER' };
  req.headers = {};
  req.emitBody = () => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); };
  return req;
}
function makeRes() {
  return { statusCode: null, headers: {}, body: '', writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; }, end(payload = '') { this.body = String(payload); if (this.resolve) this.resolve(); } };
}
async function invoke(handler, req, res) {
  const pending = new Promise(resolve => { res.resolve = resolve; });
  const task = handler(req, res, { pathname: '/api/documents/extraction', parsedUrl: { query: {} } });
  req.emitBody();
  await task;
  await pending;
}

test('document extraction persists only allowlisted structured fields', async () => {
  const store = {
    driver_documents: [{ id: 'DOC_RC_1', driverId: 'driver_1', docType: 'RC', status: 'PENDING_REVIEW', ocrResult: {} }]
  };
  const db = {
    getDb: () => store,
    saveDb: () => {},
    waitForCommit: async () => {},
    getDriverDocuments: driverId => store.driver_documents.filter(doc => doc.driverId === driverId)
  };
  const handler = createProofRoutes({ db, enforceDriverAccess: async () => true, enforceSecurityChecks: async () => true });
  const req = makeReq({
    driver_id: 'driver_1',
    document_id: 'DOC_RC_1',
    document_type: 'RC',
    fields: {
      vehicleNumber: 'TS09EA1234',
      ownerName: 'Test Owner',
      chassisLast5: '12A45',
      secretRawOcrText: 'THIS MUST NOT BE STORED'
    }
  });
  const res = makeRes();
  await invoke(handler, req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(store.driver_documents[0].extractedFields, {
    vehicleNumber: 'TS09EA1234',
    ownerName: 'Test Owner',
    chassisLast5: '12A45'
  });
  assert.equal(store.driver_documents[0].extractedFields.secretRawOcrText, undefined);
  assert.equal(store.driver_documents[0].extraction.source, 'ON_DEVICE_ML_KIT');
});

test('document extraction rejects invalid vehicle plates instead of persisting them', async () => {
  const store = { driver_documents: [{ id: 'DOC_VEH_1', driverId: 'driver_1', docType: 'VEHICLE_PHOTO', status: 'PENDING_REVIEW' }] };
  const db = { getDb: () => store, saveDb: () => {}, waitForCommit: async () => {}, getDriverDocuments: id => store.driver_documents.filter(doc => doc.driverId === id) };
  const handler = createProofRoutes({ db, enforceDriverAccess: async () => true, enforceSecurityChecks: async () => true });
  const req = makeReq({ driver_id: 'driver_1', document_id: 'DOC_VEH_1', document_type: 'VEHICLE_PHOTO', fields: { vehicleNumber: 'NOT-A-PLATE' } });
  const res = makeRes();
  await invoke(handler, req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(store.driver_documents[0].extractedFields, {});
});
