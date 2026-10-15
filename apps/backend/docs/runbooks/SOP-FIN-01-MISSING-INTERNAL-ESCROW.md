# SOP-FIN-01: Handling Missing Internal Escrow Discrepancies

**Document Code**: SOP-FIN-01  
**Target Subsystem**: VAAYU Financial Subsystem / Provider Reconciliation  
**Applicability**: Finance Operations, On-Call Engineers, Financial Auditors  
**Effective Date**: 2026-10-13  
**Frozen Architectural Boundaries**: PostgreSQL Double-Entry Ledger Core (F.1–F.7) — *Direct SQL balance edits strictly forbidden.*

---

## 1. Trigger & Severity Classification

### Trigger
A reconciliation cycle or forensic trace identifies a discrepancy of type:
`MISSING_INTERNAL_ESCROW` in table `payment_discrepancy_records`.

### Condition
The external payment provider (e.g. Razorpay) confirms that funds were captured/collected (`status: captured`), but VAAYU's internal payment transaction is in `INITIATED` status (or missing an escrow hold), typically caused by an unauthenticated, dropped, or delayed webhook callback.

### Severity
- **P2 (High)**: Individual trip/order discrepancy (< ₹10,000). Customer charged, driver cannot complete dispatch settlement.
- **P1 (Critical)**: Batch event affecting $\ge 5$ concurrent payments or total amount $\ge ₹10,000$, indicating gateway webhook endpoint severance or gateway outage.

---

## 2. Immediate Containment

1. **Do NOT delete or edit any database rows**: Never update `ledger_accounts.balance_paise` or `payment_transactions` directly via raw SQL.
2. **Halt Dispatch Cancellation**: Notify Dispatch Support not to cancel the affected trip while the financial hold is being verified.
3. **Verify Gateway Status**: Check the provider dashboard (Razorpay Dashboard $\rightarrow$ Payments) to confirm the payment is genuine and captured.

---

## 3. Evidence Collection

Collect the following canonical lineage identifiers:
- `paymentId` (e.g. `PAY_TRIP_...`)
- `tripId` / `orderId`
- `providerPaymentId` (e.g. `pay_...`)
- `providerOrderId` (e.g. `order_...`)
- `discrepancyId` from `payment_discrepancy_records`
- `batchRef` from `payment_reconciliation_batches`

### Evidence Extraction Query (Read-Only)
```sql
SELECT d.discrepancy_id, d.batch_ref, d.payment_id, d.trip_id,
       d.provider_payment_id, d.provider_order_id, d.provider_amount_paise,
       d.internal_amount_paise, d.resolution_status, m.status as mapping_status,
       t.state as transaction_state
FROM payment_discrepancy_records d
LEFT JOIN payment_provider_mappings m ON m.payment_id = d.payment_id
LEFT JOIN payment_transactions t ON t.payment_id = d.payment_id
WHERE d.discrepancy_id = $1;
```

---

## 4. Diagnostic Procedure

### Step 1: Reconstruct Trace Lineage
Execute the trace endpoint using an authorized operator token:
```http
GET /api/admin/financial/trace?discrepancy_id=<discrepancyId>
Headers:
  Authorization: Bearer <TOKEN>
```
Verify the returned status:
- If `status === 'INCONSISTENT'` with reason `unresolved OPEN financial discrepancies`, proceed.

### Step 2: Validate Gateway Capture Proof
Inspect `payment_provider_events` for this payment:
```sql
SELECT event_pk, provider_event_id, event_type, status, amount_paise, currency, created_at
FROM payment_provider_events
WHERE matched_payment_id = '<paymentId>' OR raw_payload::text LIKE '%<providerPaymentId>%'
ORDER BY created_at ASC;
```

### Stop Conditions (When to STOP and escalate):
- **Stop Condition 1**: Provider payment is NOT captured (e.g. `failed`, `authorized`, `refunded`). Do NOT create escrow.
- **Stop Condition 2**: `amount_paise` from provider does not equal `expected_amount_paise` in `payment_provider_mappings`. Escalate to **SOP-FIN-02 (Amount Mismatch)**.
- **Stop Condition 3**: Provider currency is not `INR`. Escalate to Fraud/Finance.

---

## 5. Authorized Remediation Procedure

Remediation must be conducted strictly through the authorized financial services.

### Method A: Automated Healing via Reconciliation Worker
If `autoHealMissingEscrow` is enabled, the reconciliation worker safely resolves this by:
1. Calling `topUpCustomerWallet` with deterministic idempotency key `TOPUP:<hash>`.
2. Calling `reserveEscrow` with deterministic idempotency key `HEAL:<hash>`.
3. Updating discrepancy resolution status to `AUTO_RESOLVED` and action `AUTO_HEALED_ESCROW`.

Trigger a single-item reconciliation cycle:
```bash
# Via authorized administrative task or Node script:
node -e "
const { PostgresPool } = require('./src/db/postgresClient');
const { ProviderReconciliationWorker } = require('./src/services/ledger/providerReconciliationWorker');
const { paymentIntegrationService } = require('./src/services/ledger/paymentIntegrationService');
(async () => {
  const pool = new PostgresPool({ connectionString: process.env.DATABASE_ADMIN_URL });
  const worker = new ProviderReconciliationWorker({
    poolOrConfig: pool,
    paymentIntegrationService,
    autoHealMissingEscrow: true
  });
  const res = await worker.runReconciliationCycle({ paymentId: '<paymentId>' });
  console.log('Recon result:', res);
  await pool.end();
})();
"
```

### Method B: Manual Resolution (Maker-Checker Escalation)
If automated healing failed (e.g. trip was cancelled in the interim):
1. **Operator (Maker)** submits resolution request via Four-Eyes workflow (see **SOP-FIN-04**).
2. Action: `REFUND_GATEWAY` or `DISMISSED`.
3. An authorized manager approves and executes the compensation.

---

## 6. Verification & Closure

Before closing the discrepancy:
1. Re-run `GET /api/admin/financial/trace?payment_id=<paymentId>`.
2. Confirm `payment.state === 'ESCROWED'` (or subsequent state).
3. Confirm `journalEntries` contain balanced entries (`debits === credits`).
4. Verify reconciliation:
```sql
SELECT is_balanced, resolution_status
FROM payment_discrepancy_records
WHERE discrepancy_id = <discrepancyId>;
```
Status must be `AUTO_RESOLVED` or `RESOLVED_MANUAL`.

---

## 7. Escalation & Recovery Directory

- **Primary Owner**: Finance Operations Lead
- **Escalation Contact**: Lead Financial Engineer / On-Call Backend Engineer
- **Gateway Contact**: Razorpay Support Escalation Desk
