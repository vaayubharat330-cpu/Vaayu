'use strict';

/**
 * Policy boundary for live camera sessions.
 *
 * The HTTP route is intentionally kept separate from these invariants so the
 * same rules can be reused by REST, WebSocket signalling and future WebRTC
 * signalling endpoints.
 */

const CAMERA_FRAME_MIN_INTERVAL_MS = 900;
const CAMERA_MAX_CLOCK_SKEW_MS = 30_000;

function deny(code, message) {
  return { allowed: false, code, message };
}

function assertDriverOwnsSession({ session, user }) {
  if (!session || session.status !== 'LIVE') return deny('CAMERA_SESSION_NOT_LIVE', 'The camera session is not live.');
  if (!user) return deny('AUTH_REQUIRED', 'Authentication is required.');
  const role = String(user.role || '').toUpperCase();
  if (role !== 'DRIVER') return { allowed: true };
  const userId = String(user.id || '');
  const driverId = String(session.driverId || '');
  const sessionUserId = String(session.driverUserId || '');
  if (userId !== driverId && userId !== sessionUserId) return deny('CAMERA_DRIVER_MISMATCH', 'This driver is not the owner of the camera session.');
  return { allowed: true };
}

function validateFrame({ session, user, nowMs = Date.now(), capturedAtMs = nowMs }) {
  const ownership = assertDriverOwnsSession({ session, user });
  if (!ownership.allowed) return ownership;
  const expiresAt = Date.parse(session.expiresAt || '');
  if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) return deny('CAMERA_SESSION_EXPIRED', 'The camera session has expired.');
  if (!Number.isFinite(capturedAtMs) || Math.abs(nowMs - capturedAtMs) > CAMERA_MAX_CLOCK_SKEW_MS) return deny('CAMERA_CAPTURE_TIME_INVALID', 'The camera frame timestamp is outside the accepted clock-skew window.');
  const previousCapture = Number(session.lastCapturedAtMs || 0);
  if (previousCapture > 0 && capturedAtMs < previousCapture) return deny('CAMERA_FRAME_TIME_REGRESSION', 'A camera frame older than the previous frame was submitted.');
  if (previousCapture > 0 && capturedAtMs - previousCapture < CAMERA_FRAME_MIN_INTERVAL_MS) return deny('CAMERA_FRAME_RATE_LIMITED', 'Camera frames are arriving too quickly.');
  return { allowed: true };
}

function recordAcceptedFrame(session, { capturedAtMs, sequence }) {
  if (!session) return false;
  const previousCapture = Number(session.lastCapturedAtMs || 0);
  if (previousCapture > 0 && capturedAtMs < previousCapture) return false;
  session.lastCapturedAtMs = capturedAtMs;
  session.sequence = Math.max(Number(session.sequence || 0), Number(sequence || 0));
  session.updatedAt = new Date(capturedAtMs).toISOString();
  return true;
}

module.exports = { CAMERA_FRAME_MIN_INTERVAL_MS, CAMERA_MAX_CLOCK_SKEW_MS, assertDriverOwnsSession, validateFrame, recordAcceptedFrame };
