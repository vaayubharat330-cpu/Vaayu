const test = require('node:test');
const assert = require('node:assert/strict');
const { checkInternalUniqueness, evaluateDocument, normalizeFields } = require('../../src/services/documentVerificationService');

function dbWith(documents) { return { getDb: () => ({ driver_documents: documents }) }; }

test('RC/vehicle registration is globally unique across driver accounts', () => {
  const result = checkInternalUniqueness({ db: dbWith([{ id: 'rc1', driverId: 'driver_A', docType: 'RC', extractedFields: { vehicleNumber: 'TS09EA1234', chassisLast5: '12A45' } }]), driverId: 'driver_B', documentType: 'RC', fields: { vehicleNumber: 'TS09EA1234' } });
  assert.equal(result[0].code, 'IDENTITY_ALREADY_REGISTERED');
  assert.equal(result[0].field, 'vehicleNumber');
});

test('same driver can reuse a driving licence number for another vehicle', () => {
  const result = checkInternalUniqueness({ db: dbWith([{ id: 'dl1', driverId: 'driver_A', docType: 'DRIVING_LICENSE', extractedFields: { licenseNumber: 'TS1220250012345' } }]), driverId: 'driver_A', documentType: 'DRIVING_LICENSE', fields: { licenseNumber: 'TS1220250012345' } });
  assert.deepEqual(result, []);
});

test('driving licence cannot be attached to a different driver', () => {
  const result = checkInternalUniqueness({ db: dbWith([{ id: 'dl1', driverId: 'driver_A', docType: 'DRIVING_LICENSE', extractedFields: { licenseNumber: 'TS1220250012345' } }]), driverId: 'driver_B', documentType: 'DRIVING_LICENSE', fields: { licenseNumber: 'TS1220250012345' } });
  assert.equal(result[0].code, 'LICENSE_BELONGS_TO_ANOTHER_DRIVER');
});

test('Aadhaar last four is never treated as a globally unique identity', () => {
  const result = checkInternalUniqueness({ db: dbWith([{ id: 'a1', driverId: 'driver_A', docType: 'AADHAAR', extractedFields: { aadhaarLast4: '1234' } }]), driverId: 'driver_B', documentType: 'AADHAAR', fields: { aadhaarLast4: '1234' } });
  assert.deepEqual(result, []);
});

test('official verification is required before an otherwise clean document becomes VERIFIED', () => {
  const db = dbWith([]);
  const pending = evaluateDocument({ db, driverId: 'driver_A', documentType: 'RC', fields: { vehicleNumber: 'TS09EA1234', ownerName: 'TEST OWNER' } });
  assert.equal(pending.decision, 'NEEDS_REVIEW');
  assert.equal(pending.authenticity.authenticityStatus, 'NOT_PROVEN');
  const verified = evaluateDocument({ db, driverId: 'driver_A', documentType: 'RC', fields: { vehicleNumber: 'TS09EA1234', ownerName: 'TEST OWNER' }, officialVerification: { status: 'VERIFIED_MATCH', source: 'DIGILOCKER', checkedAt: new Date().toISOString(), matches: true } });
  assert.equal(verified.decision, 'VERIFIED');
  assert.equal(verified.authenticity.authenticityStatus, 'OFFICIAL_SOURCE_MATCH');
});

test('normalizeFields canonicalizes registration values', () => { assert.equal(normalizeFields({ vehicleNumber: 'TS 09-EA 1234' }).vehicleNumber, 'TS09EA1234'); });
