// Synchronous in-memory store with durable per-record PostgreSQL persistence.
// Reads and writes stay synchronous for the application. A flush writes only the records whose
// content changed since the last flush, and only removes records that were deleted.
const { PgRecordStore, VersionConflictError, toRecords, digest } = require('./pgRecordStore');

const FLUSH_INTERVAL_MS = 250;

class PgBackedStore {
  constructor(connectionString, options = {}) {
    this.remote = new PgRecordStore(connectionString, options);
    this.snapshot = null;
    // collection -> Map(recordKey -> { hash, version })
    this.known = new Map();
    this.flushing = null;
    this.timer = null;
    this.lastError = null;
    // writeSeq counts writes; a flush clears `dirty` only if no write arrived while it ran.
    this.writeSeq = 0;
    this.dirty = false;
  }

  async load() {
    await this.remote.init();
    await this.reload();
    if (!Object.keys(this.snapshot).length) {
      throw new Error('PostgreSQL store is empty. Seed it before starting: npm run db:seed.');
    }
    this.timer = setInterval(() => {
      if (this.dirty) this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
    this.timer.unref();
    return this.snapshot;
  }

  async reload() {
    this.snapshot = await this.remote.loadAll();
    await this.syncKnown();
  }

  async syncKnown() {
    const { rows } = await this.remote.pool.query('SELECT collection, record_key, version, position, data FROM vaayu_records');
    this.known = new Map();
    for (const row of rows) {
      if (!this.known.has(row.collection)) this.known.set(row.collection, new Map());
      this.known.get(row.collection).set(row.record_key, {
        hash: digest(row.data), version: row.version, position: row.position,
      });
    }
  }

  read() {
    if (!this.snapshot) throw new Error('PgBackedStore used before load().');
    return this.snapshot;
  }

  write(data) {
    if (!this.snapshot) throw new Error('PgBackedStore used before load().');
    this.snapshot = data;
    this.writeSeq += 1;
    this.dirty = true;
  }

  hasPending() {
    return this.dirty || this.flushing !== null;
  }

  diff() {
    const changes = [];
    const seen = new Map();
    for (const [name, value] of Object.entries(this.snapshot)) {
      const records = toRecords(name, value);
      const previous = this.known.get(name) || new Map();
      const current = new Map();
      for (const [key, { item, position }] of records) {
        const hash = digest(item);
        const before = previous.get(key);
        current.set(key, { hash, version: before ? before.version : undefined, position });
        if (!before || before.hash !== hash || before.position !== position) {
          changes.push({
            collection: name, key, upsert: item, position,
            expectedVersion: before ? before.version : undefined,
          });
        }
      }
      for (const key of previous.keys()) {
        if (!current.has(key)) changes.push({ collection: name, key, remove: true });
      }
      seen.set(name, current);
    }
    for (const name of this.known.keys()) {
      if (!seen.has(name)) {
        for (const key of this.known.get(name).keys()) changes.push({ collection: name, key, remove: true });
      }
    }
    return { changes, seen };
  }

  // A version conflict is a command conflict, not a successful persistence cycle. Reload the
  // authoritative snapshot so this process does not overwrite the competing writer, then surface
  // the conflict to the command that requested durability. The caller must retry its command using
  // the newly authoritative state; the original mutation is never silently acknowledged.
  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const seqAtStart = this.writeSeq;
      const { changes } = this.diff();
      if (!changes.length) {
        if (this.writeSeq === seqAtStart) this.dirty = false;
        return;
      }
      try {
        await this.remote.saveChanges(changes);
        await this.syncKnown();
        if (this.writeSeq === seqAtStart) this.dirty = false;
        this.lastError = null;
      } catch (error) {
        this.lastError = error;
        if (error instanceof VersionConflictError) {
          console.error('[PgBackedStore] another writer changed a record; reloading from PostgreSQL.');
          await this.reload();
          // The attempted mutation must not be retried against the refreshed snapshot as if it
          // were still valid. Mark the local attempt consumed; the command receives the conflict.
          this.dirty = false;
        } else {
          console.error('[PgBackedStore] flush failed; will retry:', error.message);
        }
        throw error;
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  // Waits until every write made so far is committed to PostgreSQL. Persistence errors are
  // intentionally propagated. In particular, VersionConflictError must reach the critical command
  // so it cannot return success or emit an authoritative event for a mutation PostgreSQL rejected.
  async flushAll() {
    for (let attempt = 0; attempt < 5 && this.hasPending(); attempt += 1) {
      if (this.flushing) await this.flushing;
      if (this.dirty) await this.flush();
    }
    if (this.dirty || this.flushing) throw new Error('Writes could not be committed to PostgreSQL.');
  }

  async drain() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    await this.remote.close();
  }
}

module.exports = { PgBackedStore };
