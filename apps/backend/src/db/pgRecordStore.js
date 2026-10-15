// PostgreSQL record store. Every record of every collection is its own row, so a write changes
// only the records that changed. Each row carries a version; an update succeeds only if the
// version it was read at is still current, so two writers can't silently overwrite each other.
const crypto = require('crypto');
const { Pool } = require('pg');

const TABLE = 'vaayu_records';
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  collection TEXT NOT NULL,
  record_key TEXT NOT NULL,
  data JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, record_key)
)`;

// Collections stored as one object keyed by a name, not as an array of records.
const OBJECT_COLLECTIONS = new Set(['system_settings', 'kyc_summaries']);

// Hash of the content with keys sorted. jsonb does not keep key order, so a plain JSON.stringify
// of a stored row would differ from the in-memory value even when the content is identical.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out; }, {});
  }
  return value;
}

function safeSerializeJson(val) {
  return JSON.stringify(val).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
}

function digest(value) {
  return crypto.createHash('sha256').update(safeSerializeJson(canonical(value))).digest('hex');
}

// Splits a collection into keyed records. Array items use their `id`; items without one are keyed
// by position and content hash, so unchanged items keep the same key across writes.
function toRecords(name, value) {
  const records = new Map();
  if (OBJECT_COLLECTIONS.has(name) || (value && !Array.isArray(value))) {
    Object.entries(value || {}).forEach(([key, item], index) => records.set(String(key), { item, position: index }));
    return records;
  }
  (value || []).forEach((item, index) => {
    const key = item && item.id !== undefined && item.id !== null
      ? `id:${item.id}`
      : `pos:${index}:${digest(item).slice(0, 16)}`;
    records.set(key, { item, position: index });
  });
  return records;
}

function fromRecords(name, rows) {
  if (OBJECT_COLLECTIONS.has(name)) {
    const out = {};
    for (const row of rows) out[row.record_key] = row.data;
    return out;
  }
  return rows.map(row => row.data);
}

// Builds the upsert list that writes one whole collection.
function changesFor(name, value) {
  return [...toRecords(name, value)].map(([key, { item, position }]) => ({
    collection: name, key, upsert: item, position,
  }));
}

class PgRecordStore {
  constructor(connectionString, options = {}) {
    if (!connectionString) throw new Error('PgRecordStore requires a PostgreSQL connection string.');
    this.pool = new Pool({ connectionString, max: options.max || 10 });
    // An idle client can drop (server restart, network). Without a listener, pg crashes the process.
    this.pool.on('error', (error) => {
      console.error('[PgRecordStore] idle client error:', error.message);
    });
  }

  async init() {
    // The table is created once by the schema owner (see scratch/create_limited_role.js). The app role
    // only reads and writes rows, so it skips DDL when the table already exists.
    const { rows } = await this.pool.query("SELECT to_regclass($1) AS name", [TABLE]);
    if (rows[0] && rows[0].name) return;
    await this.pool.query(SCHEMA_SQL);
  }

  async loadAll() {
    const { rows } = await this.pool.query(`SELECT collection, record_key, data FROM ${TABLE} ORDER BY collection, position, record_key`);
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.collection)) grouped.set(row.collection, []);
      grouped.get(row.collection).push(row);
    }
    const snapshot = {};
    for (const [name, collectionRows] of grouped) snapshot[name] = fromRecords(name, collectionRows);
    return snapshot;
  }

  async count() {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
    return rows[0].n;
  }

  // Applies a list of record changes in one transaction. A change with `expectedVersion` updates
  // only if that version is still stored; otherwise it throws VersionConflictError, so the caller
  // can reload instead of overwriting another writer's data.
  async saveChanges(changes) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const change of changes) {
        if (change.upsert !== undefined) {
          if (change.expectedVersion === undefined) {
            await client.query(
              `INSERT INTO ${TABLE} (collection, record_key, data, version, position, updated_at)
               VALUES ($1, $2, $3, 1, $4, now())
               ON CONFLICT (collection, record_key) DO UPDATE
                 SET data = EXCLUDED.data, position = EXCLUDED.position,
                     version = ${TABLE}.version + 1, updated_at = now()`,
              [change.collection, change.key, safeSerializeJson(change.upsert), change.position || 0]
            );
          } else {
            const updated = await client.query(
              `UPDATE ${TABLE} SET data = $4, position = $5, version = version + 1, updated_at = now()
               WHERE collection = $1 AND record_key = $2 AND version = $3`,
              [change.collection, change.key, change.expectedVersion, safeSerializeJson(change.upsert), change.position || 0]
            );
            if (!updated.rowCount) throw new VersionConflictError(change.collection, change.key);
          }
        } else if (change.remove) {
          // Deletes are optimistic too. Without the version predicate, a stale snapshot could
          // delete a record that another writer updated after this process last loaded it.
          if (change.expectedVersion === undefined) {
            const deleted = await client.query(
              `DELETE FROM ${TABLE} WHERE collection = $1 AND record_key = $2`,
              [change.collection, change.key]
            );
            if (!deleted.rowCount) throw new VersionConflictError(change.collection, change.key);
          } else {
            const deleted = await client.query(
              `DELETE FROM ${TABLE} WHERE collection = $1 AND record_key = $2 AND version = $3`,
              [change.collection, change.key, change.expectedVersion]
            );
            if (!deleted.rowCount) throw new VersionConflictError(change.collection, change.key);
          }
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

class VersionConflictError extends Error {
  constructor(collection, key) {
    super(`Record ${collection}/${key} was changed by another writer.`);
    this.name = 'VersionConflictError';
  }
}

module.exports = { PgRecordStore, VersionConflictError, TABLE, toRecords, changesFor, digest, OBJECT_COLLECTIONS };