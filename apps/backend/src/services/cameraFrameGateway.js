'use strict';

const { validateFrame, recordAcceptedFrame } = require('./cameraSessionPolicy');
const { parseDataImage, isSequenceForward } = require('./cameraFrameIntegrity');
const { startCameraSessionJanitor } = require('./cameraSessionJanitor');

/**
 * Single frame acceptance boundary for REST today and WebRTC signalling/media
 * gateways later. Route handlers should not duplicate these checks.
 *
 * Important invariant: accept() validates and decodes only. The session cursor
 * is committed after the caller durably stores the frame, so a Redis failure
 * cannot advance the authoritative camera sequence without a frame.
 */
class CameraFrameGateway {
  constructor({ now = () => Date.now(), acquireRateSlot = async () => true } = {}) {
    this.now = now;
    this.acquireRateSlot = acquireRateSlot;
    startCameraSessionJanitor();
  }

  async accept({ session, user, imageData, sequence, capturedAt }) {
    const nowMs = this.now();
    const capturedAtMs = Date.parse(capturedAt || '') || nowMs;
    const policy = validateFrame({ session, user, nowMs, capturedAtMs });
    if (!policy.allowed) return policy;

    const nextSequence = Number(sequence);
    if (!isSequenceForward(session.sequence, nextSequence)) {
      return { allowed: false, code: 'CAMERA_SEQUENCE_INVALID', message: 'Camera frame sequence must advance exactly by one.' };
    }

    const slot = await this.acquireRateSlot(String(session.id), nowMs);
    if (!slot) return { allowed: false, code: 'CAMERA_FRAME_RATE_LIMITED', message: 'Camera frame rate limit exceeded.' };

    const parsed = parseDataImage(imageData);
    if (!parsed.ok) return { allowed: false, code: parsed.code, message: 'Camera frame binary content is invalid.' };

    return {
      allowed: true,
      sequence: nextSequence,
      capturedAt: new Date(capturedAtMs).toISOString(),
      capturedAtMs,
      ...parsed,
    };
  }

  commitAcceptedFrame(session, { sequence, capturedAtMs }) {
    if (!recordAcceptedFrame(session, { capturedAtMs, sequence })) {
      return { allowed: false, code: 'CAMERA_FRAME_STATE_CONFLICT', message: 'Camera frame state changed before acceptance.' };
    }
    return { allowed: true };
  }
}

module.exports = { CameraFrameGateway };
