// Seeds an empty PostgreSQL database from a JSON store file or the canonical clean application baseline.
// Usage: DATABASE_URL=postgres://... node src/db/seedPostgres.js [path/to/store.json]
// Refuses to run against a database that already has data, unless --force is passed.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { PgRecordStore, changesFor } = require('./pgRecordStore');

const DEFAULT_SOURCE = path.join(__dirname, 'vaayu_store.json');

function loadSnapshot(explicitSource) {
  if (explicitSource) {
    const source = path.resolve(explicitSource);
    return {
      snapshot: JSON.parse(fs.readFileSync(source, 'utf8')),
      sourceLabel: path.basename(source),
    };
  }

  if (fs.existsSync(DEFAULT_SOURCE)) {
    return {
      snapshot: JSON.parse(fs.readFileSync(DEFAULT_SOURCE, 'utf8')),
      sourceLabel: path.basename(DEFAULT_SOURCE),
    };
  }

  // The legacy JSON store is intentionally gitignored. A fresh clone therefore has no
  // vaayu_store.json, but SQLite already uses database.js's deterministic defaultData baseline.
  // Reuse that same canonical baseline for PostgreSQL so new developers get identical clean state
  // without copying stale local data into the repository.
  const { getDb } = require('./database');
  return {
    snapshot: getDb(),
    sourceLabel: 'canonical defaultData',
  };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const explicitSource = args.find(arg => !arg.startsWith('--'));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');

  const { snapshot, sourceLabel } = loadSnapshot(explicitSource);
  const store = new PgRecordStore(url);
  try {
    await store.init();
    const existing = await store.count();
    if (existing && !force) {
      throw new Error(`Database already has ${existing} records. Pass --force to replace them, or use an empty database.`);
    }
    if (existing && force) {
      await store.pool.query('DELETE FROM vaayu_records');
    }

    const changes = Object.entries(snapshot).flatMap(([name, value]) => changesFor(name, value));
    await store.saveChanges(changes);
    console.log(`Seeded ${changes.length} records across ${Object.keys(snapshot).length} collections from ${sourceLabel}.`);
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error('Seed failed:', error.message);
  process.exit(1);
});
