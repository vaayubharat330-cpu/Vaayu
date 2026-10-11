// Seeds an empty PostgreSQL database from a JSON store file.
// Usage: DATABASE_URL=postgres://... node src/db/seedPostgres.js [path/to/store.json]
// Refuses to run against a database that already has data, unless --force is passed.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { PgRecordStore, changesFor } = require('./pgRecordStore');

const DEFAULT_SOURCE = path.join(__dirname, 'vaayu_store.json');

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const source = path.resolve(args.find(arg => !arg.startsWith('--')) || DEFAULT_SOURCE);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');

  const snapshot = JSON.parse(fs.readFileSync(source, 'utf8'));
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
    console.log(`Seeded ${changes.length} records across ${Object.keys(snapshot).length} collections from ${path.basename(source)}.`);
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error('Seed failed:', error.message);
  process.exit(1);
});
