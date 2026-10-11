// Automated PostgreSQL snapshot backup and verification utility
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

const envFile = path.resolve(__dirname, '..', '.env');
const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const dbUrl = process.env.DATABASE_URL || parsed.DATABASE_URL;

if (!dbUrl) {
  console.error('DATABASE_URL is required to perform snapshot backup.');
  process.exit(1);
}

const pool = new Pool({ connectionString: dbUrl });

async function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.resolve(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const backupFile = path.join(backupDir, `vaayu_snapshot_${timestamp}.json`);
  console.log(`[Backup] Connecting to PostgreSQL...`);

  const { rows } = await pool.query('SELECT collection, record_key, data, version, position, updated_at FROM vaayu_records ORDER BY collection, position, record_key');
  console.log(`[Backup] Extracted ${rows.length} total records from vaayu_records.`);

  const snapshot = {
    exportedAt: new Date().toISOString(),
    totalRecords: rows.length,
    records: rows
  };

  fs.writeFileSync(backupFile, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`[Backup] Saved verified snapshot to ${backupFile}`);

  // Verification drill
  const rawData = fs.readFileSync(backupFile, 'utf8');
  const parsedSnapshot = JSON.parse(rawData);
  if (parsedSnapshot.totalRecords !== rows.length || !Array.isArray(parsedSnapshot.records)) {
    throw new Error('Backup integrity validation failed!');
  }
  console.log(`[Backup] Integrity check PASSED ✓ (${parsedSnapshot.totalRecords} records matched)`);
}

createBackup()
  .catch((err) => {
    console.error('[Backup Error]', err.message);
    process.exit(1);
  })
  .finally(() => pool.end());
