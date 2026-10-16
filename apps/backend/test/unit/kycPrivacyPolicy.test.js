'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeExtractedFields, isSha256 } = require('../../src/services/kycPrivacyPolicy');

test('KYC privacy policy masks sensitive structured identity fields', () => {
  const safe = sanitizeExtractedFields({
    ownerName: 'TEST DRIVER',
    licenseNumber: 'DL-123456789',
    phone: '9876543210',
    vehicleClass: 'LMV',
    nested: { panNumber: 'ABCDE1234F', color: 'WHITE' }
  });

  assert.equal(safe.ownerName, '*******IVER');
  assert.equal(safe.licenseNumber, '********6789');
  assert.equal(safe.phone, '******3210');
  assert.equal(safe.vehicleClass, 'LMV');
  assert.equal(safe.nested.panNumber, '******234F');
  assert.equal(safe.nested.color, 'WHITE');
});

test('KYC privacy policy validates evidence hashes', () => {
  assert.equal(isSha256('a'.repeat(64)), true);
  assert.equal(isSha256('not-a-hash'), false);
  assert.equal(isSha256(null), false);
});

test('KYC privacy policy does not mutate source fields', () => {
  const source = { ownerName: 'TEST DRIVER', vehicleClass: 'LMV' };
  const safe = sanitizeExtractedFields(source);
  assert.equal(source.ownerName, 'TEST DRIVER');
  assert.notStrictEqual(safe, source);
});
