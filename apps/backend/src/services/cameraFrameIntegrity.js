'use strict';

const crypto = require('crypto');

const MAX_FRAME_BYTES = 750 * 1024;
const ALLOWED_FORMATS = Object.freeze({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });

function hasValidSignature(format, bytes) {
  if (!Buffer.isBuffer(bytes)) return false;
  if (format === 'jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (format === 'png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (format === 'webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseDataImage(data, maxBytes = MAX_FRAME_BYTES) {
  if (typeof data !== 'string') return { ok: false, code: 'CAMERA_FRAME_INVALID' };
  const match = data.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return { ok: false, code: 'CAMERA_FRAME_FORMAT_INVALID' };
  const format = match[1];
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxBytes) return { ok: false, code: 'CAMERA_FRAME_TOO_LARGE' };
  if (!hasValidSignature(format, bytes)) return { ok: false, code: 'CAMERA_FRAME_CONTENT_MISMATCH' };
  return { ok: true, format, contentType: ALLOWED_FORMATS[format], bytes, sha256: sha256(bytes) };
}

/** Validates bytes retrieved from ephemeral storage before returning them to a client. */
function verifyBinaryFrame({ format, bytes, expectedSha256 }, maxBytes = MAX_FRAME_BYTES) {
  if (!ALLOWED_FORMATS[format] || !Buffer.isBuffer(bytes) || !bytes.length) return { ok: false, code: 'CAMERA_FRAME_INVALID' };
  if (bytes.length > maxBytes) return { ok: false, code: 'CAMERA_FRAME_TOO_LARGE' };
  if (!hasValidSignature(format, bytes)) return { ok: false, code: 'CAMERA_FRAME_CONTENT_MISMATCH' };
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256)) return { ok: false, code: 'CAMERA_FRAME_INTEGRITY_METADATA_INVALID' };
  const actualSha256 = sha256(bytes);
  const expected = Buffer.from(expectedSha256, 'hex');
  const actual = Buffer.from(actualSha256, 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return { ok: false, code: 'CAMERA_FRAME_INTEGRITY_MISMATCH' };
  return { ok: true, contentType: ALLOWED_FORMATS[format], sha256: actualSha256 };
}

function isSequenceForward(previousSequence, nextSequence) {
  const previous = Number(previousSequence);
  const next = Number(nextSequence);
  if (!Number.isSafeInteger(previous) || previous < 0) return false;
  return Number.isSafeInteger(next) && next === previous + 1;
}

module.exports = { MAX_FRAME_BYTES, ALLOWED_FORMATS, hasValidSignature, parseDataImage, verifyBinaryFrame, isSequenceForward };
