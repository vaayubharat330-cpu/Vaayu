# SOP-FIN-03: Transactional Outbox Dead Letter Queue (DLQ) Investigation & Redrive

**Document Code**: SOP-FIN-03  
**Target Subsystem**: Transactional Outbox Dispatcher (`outboxDispatcher.js`)  
**Applicability**: Backend Platform Engineers, On-Call DevOps, Finance Operations  
**Effective Date**: 2026-10-13  
**Frozen Architectural Boundaries**: Outbox records are atomically committed with ledger transactions. *Preserve event IDs and at-least-once delivery semantics.*

---

## 1. Trigger & Severity Classification

### Trigger
An alert fires indicating `OUTBOX_DLQ_FAILED_EVENTS > 0` or row in `payment_outbox` has `status = 'FAILED'` after exhausting `maxAttempts` (default 5 attempts).

### Condition
A domain event (e.g. `PaymentEscrowed`, `PaymentSettled`, `DriverPayoutDisbursed`) was committed atomically with the PostgreSQL ledger transaction, but the background dispatcher could not broadcast it downstream (WebSocket server network partition, Redis cluster unavailable, or subscriber worker crash).

### Severity
- **P2 (High)**: If affecting customer or driver UI telemetry (drivers do not receive dispatch completion alert, customers see loading spinner).
- **P1 (Critical)**: If $> 50$ events are stranded in DLQ, indicating widespread downstream transport network partition.

---

## 2. Immediate Containment

1. **Check Downstream Health**: Verify whether the downstream message consumers (WebSockets, Push Notifications, Redis) are online before redriving.
2. **Prevent Duplicate Financial Mutations**: Outbox redrives ONLY trigger messaging broadcasts; they must NEVER invoke new ledger postings. The financial ledger transaction was ALREADY committed.

---

## 3. Evidence Collection

Query the DLQ table to inspect trapped events and error stacks:

### Read-Only Inspection Query
```sql
SELECT outbox_id, event_id, aggregate_type, aggregate_id, event_type,
       attempt_count, last_error, created_at, payload
FROM payment_outbox
WHERE status = 'FAILED'
ORDER BY outbox_id ASC
LIMIT 50;
```

---

## 4. Diagnostic Procedure

### Step 1: Identify Root Cause from `last_error`
- `ECONNREFUSED` / `ETIMEDOUT`: Downstream socket or Redis cluster was unreachable.
- `Downstream network crash during outbox broadcast`: Network glitch during WebSocket frame transmission.
- `SyntaxError` / `JSON Parse`: Malformed payload (rare; aggregate payloads are JSON-validated).

### Step 2: Verify Downstream State
Before redriving an event like `PaymentSettled`:
Check if the client or driver app already received the state through standard polling:
```sql
SELECT state FROM payment_transactions WHERE payment_id = '<aggregateId>';
```
Because the ledger state is authoritative (`SETTLED`), the redrive is safe and idempotent.

---

## 5. Authorized Remediation Procedure

### Step 1: Resolve the Downstream Infrastructure
Ensure Redis or the WebSocket service is running and accepting connections.

### Step 2: Controlled Redrive via Authorized Dispatcher
Do NOT update the payload. Reset the `attempt_count`, clear `last_error`, set `next_attempt_at = NOW()`, and restore status to `'PENDING'`.

```sql
-- Safe redrive script for specific event
UPDATE payment_outbox
SET status = 'PENDING',
    attempt_count = 0,
    next_attempt_at = NOW(),
    last_error = 'Queued for redrive by operator: ' || NOW()
WHERE event_id = '<eventId>' AND status = 'FAILED';
```

Or for a batch of transient failures:
```sql
UPDATE payment_outbox
SET status = 'PENDING',
    attempt_count = 0,
    next_attempt_at = NOW()
WHERE status = 'FAILED'
  AND last_error LIKE '%ECONNREFUSED%'
  AND created_at > NOW() - INTERVAL '6 hours';
```

### Step 3: Trigger Immediate Poll Cycle
Run a dispatch cycle to clear the pending queue:
```bash
node -e "
const { PostgresPool } = require('./src/db/postgresClient');
const { OutboxDispatcher } = require('./src/services/ledger/outboxDispatcher');
(async () => {
  const pool = new PostgresPool({ connectionString: process.env.DATABASE_ADMIN_URL });
  const dispatcher = new OutboxDispatcher({ poolOrConfig: pool, batchSize: 25 });
  const processed = await dispatcher.pollAndDispatch();
  console.log('Processed and published events:', processed);
  await pool.end();
})();
"
```

---

## 6. Verification & Closure

1. Check that the event status transitioned to `PUBLISHED`:
```sql
SELECT status, published_at, attempt_count
FROM payment_outbox
WHERE event_id = '<eventId>';
```
Expected result: `status = 'PUBLISHED'` and `published_at IS NOT NULL`.

2. Verify system anomalies count:
```http
GET /api/admin/financial/anomalies
```
Alert `OUTBOX_DLQ_FAILED_EVENTS` must no longer appear.

---

## 7. Escalation & Recovery Directory

- **Primary Owner**: Infrastructure / Backend On-Call Engineer
- **Escalation Contact**: Core Platform Team Lead
