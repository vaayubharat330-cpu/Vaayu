'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function runMigrations() {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_ADMIN_URL or DATABASE_URL must be set in environment.');
  }

  const client = new Client({ connectionString });
  await client.connect();

  console.log('[Migration] Connected to PostgreSQL. Applying VAAYU schema...');
  try {
    const migrationFiles = [
      '001_create_ledger_and_payment_tables.sql',
      '002_create_payment_provider_events_table.sql',
      '003_create_provider_reconciliation_tables.sql',
      '004_create_financial_security_audit_tables.sql',
      '005_create_kyc_verification_tables.sql',
      '006_fix_kyc_license_reuse.sql',
      '007_kyc_license_owner_registry.sql'
    ];

    for (const fileName of migrationFiles) {
      const sqlPath = path.join(__dirname, 'migrations', fileName);
      if (fs.existsSync(sqlPath)) {
        const sql = fs.readFileSync(sqlPath, 'utf8');
        await client.query(sql);
        console.log(`[Migration] Schema migration ${fileName} applied successfully.`);
      }
    }

    const systemAccounts = [
      { id: 'cash:external', type: 'ASSET', normal: 'DEBIT' },
      { id: 'escrow:platform', type: 'LIABILITY', normal: 'CREDIT' },
      { id: 'platform:commission', type: 'REVENUE', normal: 'CREDIT' },
      { id: 'platform:gst', type: 'LIABILITY', normal: 'CREDIT' },
      { id: 'payout:clearing', type: 'LIABILITY', normal: 'CREDIT' }
    ];

    for (const acc of systemAccounts) {
      await client.query(`
        INSERT INTO ledger_accounts (account_id, account_type, normal_balance, balance_paise, debit_paise, credit_paise, version)
        VALUES ($1, $2, $3, 0, 0, 0, 1)
        ON CONFLICT (account_id) DO NOTHING;
      `, [acc.id, acc.type, acc.normal]);
    }
    console.log('[Migration] System accounts initialized.');

    await client.query(`
      DO $$
      BEGIN
          IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'vaayu_app_limited') THEN
              GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vaayu_app_limited;
              GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vaayu_app_limited;
          END IF;
      END $$;
    `);

    return true;
  } catch (err) {
    console.error('[Migration] Migration failed:', err);
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('[Migration] Finished successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migration] Failed with error:', err.message);
      process.exit(1);
    });
}

module.exports = { runMigrations };
