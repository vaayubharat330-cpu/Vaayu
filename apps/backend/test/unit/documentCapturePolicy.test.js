'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCapture, DOCUMENT_CAPTURE_DECISIONS } = require('../../src/services/documentCapturePolicy');

test('handwritten document is rejected before issuer verification', () => {
  const result = evaluateCapture({ documentDetected: true, handwrittenLikely: true, imageQuality: 'PASS' });
  assert.equal(result.decision, DOCUMENT_CAPTURE_DECISIONS.REJECT);
});

test('screen capture is routed to review rather than accepted', () => {
  const result = evaluateCapture({ documentDetected: true, screenCaptureLikely: true, imageQuality: 'PASS' });
  assert.equal(result.decision, DOCUMENT_CAPTURE_DECISIONS.REVIEW);
});

test('poor image requests a retake', () => {
  const result = evaluateCapture({ documentDetected: true, imageQuality: 'RETAKE' });
  assert.equal(result.decision, DOCUMENT_CAPTURE_DECISIONS.RETAKE);
});

test('blur, glare and coverage thresholds produce a retake', () => {
  const result = evaluateCapture({ documentDetected: true, blurScore: 0.1, glareRatio: 0.5, documentCoverage: 0.3, imageQuality: 'PASS' });
  assert.equal(result.decision, DOCUMENT_CAPTURE_DECISIONS.RETAKE);
  assert.ok(result.reasons.includes('BLUR_TOO_HIGH'));
  assert.ok(result.reasons.includes('GLARE_TOO_HIGH'));
  assert.ok(result.reasons.includes('DOCUMENT_TOO_SMALL_IN_FRAME'));
});

test('good capture passes the deterministic gate', () => {
  const result = evaluateCapture({ documentDetected: true, imageQuality: 'PASS', blurScore: 0.9, glareRatio: 0.05, documentCoverage: 0.8, ocrConfidence: 0.92 });
  assert.equal(result.decision, DOCUMENT_CAPTURE_DECISIONS.ACCEPT);
});
