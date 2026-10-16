'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDataImage, isSequenceForward } = require('../../src/services/cameraFrameIntegrity');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]).toString('base64');
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

test('camera sequence must advance exactly one step', () => {
  assert.equal(isSequenceForward(7, 8), true);
  assert.equal(isSequenceForward(7, 9), false);
  assert.equal(isSequenceForward(7, 7), false);
});
