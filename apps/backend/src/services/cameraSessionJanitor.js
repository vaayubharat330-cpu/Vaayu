'use strict';

/**
 * Reaps expired live-camera sessions and their ephemeral Redis frames.
 *
 * Camera frames are deliberately short-lived. Request-time expiry checks are
 * still authoritative, but a background reaper prevents abandoned sessions
 * and Redis blobs from accumulating when a client disappears silently.
 */
class CameraSessionJanitor {
  constructor({ db, redisClient, now = () => Date.now(), keyPrefix = 'vaayu:camera:frame:' } = {}) {
    this.db = db;
    this.redisClient = redisClient;
    this.now = now;
    this.keyPrefix = keyPrefix;
    this.running = false;
  }

  async reap() {
    if (this.running || !this.db) return { reaped: 0 };
    this.running = true;
    try {
      const store = typeof this.db.getDb === 'function' ? this.db.getDb() : null;
      const sessions = store && Array.isArray(store.camera_stream_sessions) ? store.camera_stream_sessions : [];
      const nowMs = this.now();
      let reaped = 0;
      let changed = false;

      for (const session of sessions) {
        if (!session || session.status !== 'LIVE') continue;
        const expiresAt = Date.parse(session.expiresAt || '');
        if (!Number.isFinite(expiresAt) || expiresAt > nowMs) continue;

        session.status = 'EXPIRED';
        session.updatedAt = new Date(nowMs).toISOString();
        session.latestFrameRef = null;
        session.latestFrameSha256 = null;
        changed = true;
        reaped += 1;

        if (this.redisClient && typeof this.redisClient.del === 'function' && session.id) {
          try {
            await this.redisClient.del(`${this.keyPrefix}${session.id}`);
          } catch (_) {
            // Redis cleanup is best-effort; DB expiry remains authoritative.
          }
        }
      }

      if (changed && typeof this.db.saveDb === 'function') {
        this.db.saveDb(store);
        if (typeof this.db.waitForCommit === 'function') await this.db.waitForCommit();
      }
      return { reaped };
    } finally {
      this.running = false;
    }
  }
}

let started = false;
function startCameraSessionJanitor({ intervalMs = 60_000 } = {}) {
  if (started || process.env.NODE_ENV === 'test') return null;
  // Lazy imports keep unit tests side-effect free and avoid making camera
  // policy modules responsible for application bootstrap dependencies.
  const db = require('../db/database');
  const { redisPubSub } = require('./redisPubSub');
  const janitor = new CameraSessionJanitor({ db, redisClient: redisPubSub.pubClient });
  started = true;
  const timer = setInterval(() => {
    janitor.reap().catch(() => {});
  }, intervalMs);
  if (timer.unref) timer.unref();
  janitor.reap().catch(() => {});
  return janitor;
}

module.exports = { CameraSessionJanitor, startCameraSessionJanitor };
