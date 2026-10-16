'use strict';

const { validateFrame, recordAcceptedFrame } = require('./cameraSessionPolicy');
const { parseDataImage, isSequenceForward } = require('./cameraFrameIntegrity');

/**
 * Single frame acceptance boundary for REST today and WebRTC signalling/media
 * gateways later. Route handlers should not duplicate these checks.
 */
class CameraFrameGateway {
  constructor({ now = () => Date.now(), acquireRateSlot = async () => true } = {}) {
    this.now = now;
    this.acquireRateSlot = acquireRateSlot;
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

    if (!recordAcceptedFrame(session, { capturedAtMs, sequence: nextSequence })) {
      return { allowed: false, code: 'CAMERA_FRAME_STATE_CONFLICT', message: 'Camera frame state changed before acceptance.' };
    }

    return {
      allowed: true,
      sequence: nextSequence,
      capturedAt: new Date(capturedAtMs).toISOString(),
      ...parsed,
    };
  }
}

module.exports = { CameraFrameGateway };
