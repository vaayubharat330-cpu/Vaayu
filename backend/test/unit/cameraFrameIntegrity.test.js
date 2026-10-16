'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDataImage, verifyStoredFrame, isSequenceForward } = require('../../src/services/cameraFrameIntegrity');

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
const JPEG = JPEG_BYTES.toString('base64');
const PNG = Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]).toString('base64');

test('camera frame validator accepts genuine JPEG signature', () => {
  const result = parseDataImage(`data:image/jpeg;base64,${JPEG}`);
  assert.equal(result.ok, true);
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.sha256.length, 64);
});

test('camera frame validator accepts PNG and WebP signatures', () => {
  assert.equal(parseDataImage(`data:image/png;base64,${PNG}`).ok, true);
  assert.equal(parseDataImage(`data:image/webp;base64,${WEBP}`).ok, true);
});

test('camera frame validator rejects MIME/content mismatch', () => {
  const result = parseDataImage(`data:image/jpeg;base64,${PNG}`);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAMERA_FRAME_CONTENT_MISMATCH');
});

test('camera frame validator rejects invalid payloads', () => {
  assert.equal(parseDataImage('not-an-image').ok, false);
});

test('stored camera frame verifier accepts untampered frame bytes', () => {
  const parsed = parseDataImage(`data:image/jpeg;base64,${JPEG}`);
  const result = verifyStoredFrame({ format: parsed.format, bytes: parsed.bytes, sha256: parsed.sha256 });
  assert.equal(result.ok, true);
  assert.equal(result.sha256, parsed.sha256);
});

test('stored camera frame verifier rejects byte tampering', () => {
  const parsed = parseDataImage(`data:image/jpeg;base64,${JPEG}`);
  const tampered = Buffer.from(parsed.bytes);
  tampered[tampered.length - 1] ^= 0xff;
  const result = verifyStoredFrame({ format: parsed.format, bytes: tampered, sha256: parsed.sha256 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAMERA_FRAME_INTEGRITY_MISMATCH');
});

test('stored camera frame verifier rejects signature tampering even with a recomputed hash', () => {
  const parsed = parseDataImage(`data:image/jpeg;base64,${JPEG}`);
  const tampered = Buffer.from(parsed.bytes);
  tampered[0] = 0x00;
  const sha256 = require('crypto').createHash('sha256').update(tampered).digest('hex');
  const result = verifyStoredFrame({ format: parsed.format, bytes: tampered, sha256 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CAMERA_FRAME_CONTENT_MISMATCH');
});

test('camera sequence must advance exactly one step', () => {
  assert.equal(isSequenceForward(7, 8), true);
  assert.equal(isSequenceForward(7, 9), false);
  assert.equal(isSequenceForward(7, 7), false);
});
