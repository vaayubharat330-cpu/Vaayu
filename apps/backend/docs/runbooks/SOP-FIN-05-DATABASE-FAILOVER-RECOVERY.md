# SOP-FIN-05: Database Failover, Restore Verification & Financial DR Recovery

**Severity / Tier**: P0 (System Disaster / Data Center Outage / Catastrophic Database Failure)  
**Target Roles**: Infrastructure Engineering, Lead Financial SRE, Super Admin (`SUPER_ADMIN`)  
**Scope**: End-to-end recovery procedures following PostgreSQL failure, failover to standby, point-in-time recovery (PITR), ledger integrity verification, and post-restore financial validation.

---

## 1. Incident Declaration & Triggers

Initiate this SOP immediately upon:
- Unrecoverable primary database corruption or hardware termination.
- Split-brain / ungraceful failover requiring confirmation of financial continuity.
- Inability to acquire transaction locks or catastrophic disk exhaustion on primary PG instance.

---

## 2. Phase 1 — Write Fencing & Service Isolation

Before initiating failover or restore operations, all client-facing mutations must be isolated to prevent split-brain and orphaned ledger entries:

1. **Activate Maintenance Fence on API Gateways**:
   Disable incoming payment ingestion and dispatch updates across all nodes:
   ```bash
   # Route incoming requests to maintenance 503 response
   export FINANCIAL_MAINTENANCE_MODE="true"
   ```
2. **Halt Outbox Dispatchers & Reconciliation Workers**:
   ```bash
   # Terminate background outbox polling across backend instances
   pm2 stop vaayu-outbox-worker
   pm2 stop vaayu-recon-scheduler
   ```
3. **Fence Primary Database Connections (If accessible)**:
   ```sql
   -- Terminate non-admin sessions on primary
   SELECT pg_terminate_backend(pid) 
   FROM pg_stat_activity 
   WHERE datname = 'vaayu' 
     AND pid <> pg_backend_pid() 
     AND usename <> 'postgres';
   ```

---

## 3. Phase 2 — Target Snapshot / Backup Identification

Identify the verified recovery point snapshot:
- **Scheduled Automated Dumps**: S3 bucket `s3://vaayu-backups-prod/postgres/`
- **WAL Archive**: WAL-G / pgBackRest continuous archive up to targeted timestamp `T_failover`.

Inspect snapshot metadata:
```bash
# Verify checksum and backup manifest
sha256sum backup-20261013-050000.sql.gz
```

---

## 4. Phase 3 — Restore Execution to Clean Target

Execute isolated restore using `databaseDisasterRecovery.js` or the automated CLI tool:

```bash
# Set connection to target recovery database
export DATABASE_ADMIN_URL="postgres://vaayu_app:secure_pass@127.0.0.1:5432/vaayu_dr_recovery"

# Execute programmatic streaming restore
node -e "
  const { runRestorePipeline } = require('./src/services/ledger/databaseDisasterRecovery');
  runRestorePipeline({
    backupFilePath: '/var/backups/vaayu/backup-20261013-050000.sql.gz',
    targetDb: 'vaayu_dr_recovery'
  }).then(res => console.log('Restore complete:', res))
    .catch(err => { console.error('Restore failed:', err); process.exit(1); });
"
```

---

## 5. Phase 4 — The 12 Financial Invariant Audit Checks

> [!IMPORTANT]
> **NO SYSTEM RESUMPTION IS PERMITTED UNTIL ALL 12 INVARIANTS PASS WITH ZERO ERRORS.**

The automated disaster recovery harness checks the following 12 database invariants:

| # | Invariant | SQL Verification Logic | Acceptance Criteria |
|---|---|---|---|
| 1 | `JOURNAL_POSTINGS_REFERENTIAL_INTEGRITY` | Postings pointing to non-existent journal entry | Count = 0 |
| 2 | `ZERO_SUM_BALANCED_JOURNAL_ENTRIES` | Sum of debit and credit per journal entry | Max delta = ₹0.00 |
| 3 | `POSTING_AMOUNT_POSITIVITY` | Postings with amount $\le 0$ | Count = 0 |
| 4 | `VALID_ACCOUNT_TYPE_STRUCTURE` | Postings with invalid/null account types | Count = 0 |
| 5 | `MATERIALIZED_BALANCE_ALIGNMENT` | `user_balances` vs sum of ledger postings | Delta = ₹0.00 across all accounts |
| 6 | `DRIVER_BALANCE_ALIGNMENT` | `driver_balances` vs sum of ledger postings | Delta = ₹0.00 across all drivers |
| 7 | `IMMUTABLE_AUDIT_LOG_PRESERVATION` | Audit log records without timestamps/actors | Count = 0 |
| 8 | `PAYMENT_STATE_LEDGER_CONSISTENCY` | Captured payments missing escrow postings | Count = 0 |
| 9 | `IDEMPOTENCY_RECORD_SURVIVAL` | Missing idempotency keys on completed payments | Count = 0 |
| 10 | `OUTBOX_PAYMENT_CORRELATION` | Outbox messages referencing non-existent payments | Count = 0 |
| 11 | `PROVIDER_EVENT_INTEGRITY` | Provider events missing raw payload or signatures | Count = 0 |
| 12 | `ZERO_ORPHANED_DISCREPANCIES` | Open discrepancies referencing non-existent payments | Count = 0 |

Execute the automated verification:
```bash
npm run test:dr
```
Expected output: **4/4 passing**, `Invariant audit passed (12/12)`.

---

## 6. Phase 5 — Post-Restore Write Test & PITR Verification

Verify that the restored database is fully read-write capable and enforces sequence progression:

1. **Verify Read-Write Capabilities**:
   Execute a synthetic probe transaction via `databaseDisasterRecovery.verifyPostRestoreWrites()`:
   - Create isolated probe test account.
   - Post ₹1.00 debit and ₹1.00 credit.
   - Verify transaction commits cleanly and releases locks.
2. **Verify Point-In-Time Isolation**:
   Confirm that transactions initiated *after* the backup point are NOT partially present (no dirty partial state).

---

## 7. Phase 6 — Traffic Promotion & Cutover Signoff

Once all 12 checks pass:
1. **Update Connection Strings in Production Secrets**:
   Point backend connection pools (`DATABASE_URL`, `DATABASE_ADMIN_URL`) to the newly promoted primary database.
2. **Restart Outbox Dispatchers**:
   ```bash
   pm2 restart vaayu-outbox-worker
   ```
3. **Execute Full Reconciliation Sweep**:
   Run an immediate catch-up reconciliation job to ingest any provider events received during the failover window:
   ```bash
   node -e "
     const { reconcileRecentPayments } = require('./src/services/ledger/paymentReconciliationService');
     reconcileRecentPayments({ lookbackHours: 24 }).then(console.log);
   "
   ```
4. **Disable Maintenance Fence**:
   Restore client traffic.

---

## 8. Rollback / Emergency Contingency

If the invariant audit fails during DR restore:
- **DO NOT PROMOTE THE DATABASE.**
- Retain the recovery database as `vaayu_dr_corrupt_investigation` for forensics.
- Roll back to the preceding valid snapshot ($T - 1$).
- Escalate immediately to Tier-3 Lead Financial Systems Architect.
