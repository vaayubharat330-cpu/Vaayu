'use strict';

/**
 * Reaps expired live-camera sessions and their ephemeral Redis frames.
 *
 * Camera frames are deliberately short-lived. Relying only on request-time
 * expiry checks leaves stale session records and Redis blobs behind when a
 * driver simply closes the app, so production needs a bounded background
 * cleanup path as well.
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
            // Redis cleanup is best-effort; expiry remains authoritative in DB.
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

module.exports = { CameraSessionJanitor };
