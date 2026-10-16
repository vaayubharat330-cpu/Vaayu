'use strict';

const crypto = require('crypto');

const MAX_FRAME_BYTES = 750 * 1024;
const ALLOWED_FORMATS = Object.freeze({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
const FORMAT_SIGNATURES = Object.freeze({
  jpeg: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  png: bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
  webp: bytes => bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
});

function hasValidSignature(format, bytes) {
  return Boolean(FORMAT_SIGNATURES[format] && FORMAT_SIGNATURES[format](bytes));
}

function parseDataImage(data, maxBytes = MAX_FRAME_BYTES) {
  if (typeof data !== 'string') return { ok: false, code: 'CAMERA_FRAME_INVALID' };
  const match = data.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return { ok: false, code: 'CAMERA_FRAME_FORMAT_INVALID' };
  const format = match[1];
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxBytes) return { ok: false, code: 'CAMERA_FRAME_TOO_LARGE' };

  // Validate the actual binary signature instead of trusting the MIME label.
  if (!hasValidSignature(format, bytes)) return { ok: false, code: 'CAMERA_FRAME_CONTENT_MISMATCH' };

  return {
    ok: true,
    format,
    contentType: ALLOWED_FORMATS[format],
    bytes,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function verifyStoredFrame({ format, bytes, sha256 }, maxBytes = MAX_FRAME_BYTES) {
  if (!ALLOWED_FORMATS[format] || !Buffer.isBuffer(bytes) || !bytes.length) return { ok: false, code: 'CAMERA_FRAME_INVALID' };
  if (bytes.length > maxBytes) return { ok: false, code: 'CAMERA_FRAME_TOO_LARGE' };
  if (!hasValidSignature(format, bytes)) return { ok: false, code: 'CAMERA_FRAME_CONTENT_MISMATCH' };
  const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256) || !crypto.timingSafeEqual(Buffer.from(actualSha256, 'hex'), Buffer.from(sha256, 'hex'))) {
    return { ok: false, code: 'CAMERA_FRAME_INTEGRITY_MISMATCH' };
  }
  return { ok: true, contentType: ALLOWED_FORMATS[format], sha256: actualSha256 };
}

function isSequenceForward(previousSequence, nextSequence) {
  const previous = Number(previousSequence || 0);
  const next = Number(nextSequence || 0);
  return Number.isSafeInteger(next) && next === previous + 1;
}

module.exports = { MAX_FRAME_BYTES, ALLOWED_FORMATS, parseDataImage, verifyStoredFrame, isSequenceForward };
