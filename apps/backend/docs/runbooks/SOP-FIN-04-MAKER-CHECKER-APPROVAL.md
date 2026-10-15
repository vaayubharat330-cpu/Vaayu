# SOP-FIN-04: Maker-Checker Financial Approvals & Dual-Control Operations

**Severity / Tier**: P2 (Routine Operations / High-Value Controls) / P1 (Dispute/Discretionary Override)  
**Target Roles**: Financial Operations (`FINANCE_ADJUST`, `FINANCE_REFUND`, `FINANCE_RESOLVE`, `FINANCE_PAYOUT`), Super Admin (`SUPER_ADMIN`)  
**Scope**: Dual-control authorization requirements for manual financial adjustments, refunds above threshold, manual settlement overrides, and payout corrections.

---

## 1. Context & Regulatory Rationale

To comply with statutory financial controls and prevent unilateral insider fraud, embezzlement, or accidental ledger corruption, high-impact financial mutations cannot be executed by a single individual.

The VAAYU financial subsystem strictly enforces **Dual Control (Maker-Checker / Four-Eyes Principle)** at the database and application boundary:
- **Maker**: Originates the financial adjustment request, attaching business context, audit references, and proposed accounting legs.
- **Checker**: Reviews independently, verifying third-party evidence, gateway settlement files, or customer support dispute logs before granting approval or rejection.
- **System Invariant**: The Checker **cannot** be the same entity as the Maker (`requestedBy !== decidedBy`). Self-approval attempts result in an immediate `DUAL_CONTROL_VIOLATION` exception and trigger an immutable security audit alert.

---

## 2. Thresholds & Trigger Criteria

Dual-control approval (`financial_approval_requests`) is mandatory for:
1. **High-Value Refunds**: Any manual refund $\ge ₹5,000$ (500,000 paise).
2. **Discretionary Credit / Ledger Adjustment**: Any balance adjustment (`MANUAL_ADJUSTMENT`, `GOODWILL_CREDIT`) across user or driver pocket balances.
3. **Escrow Dispute Overrides**: Releasing escrow funds outside the automated `DeliveryStateMachine` lifecycle.
4. **Discrepancy Write-Offs / Dismissals**: Resolving high-value discrepancies (`MANUAL_COMPENSATING_ENTRY`) identified during reconciliation.

---

## 3. Workflow Lifecycle

```text
 ┌────────────────┐
 │     Maker      │ ── Submits Request ──► [status: PENDING]
 └────────────────┘                                │
                                                   ▼
 ┌────────────────┐                      Independent Review
 │    Checker     │                                │
 └────────────────┘                      ┌─────────┴─────────┐
                                         ▼                   ▼
                                 [status: APPROVED]  [status: REJECTED]
                                         │                   │
                                         ▼                   ▼
                                 Atomic Ledger       Audit Record
                                 Mutation Executed   Preserved (No Fund Movement)
```

---

## 4. Phase 1 — Maker Procedure (Initiation)

1. **Verify Root Cause & Justification**: Ensure the support ticket, dispute ID, or gateway bank transaction reference is verified and documented.
2. **Submit via Financial Security Service**:
   Call `financialSecurityService.createApprovalRequest()` via authorized admin console or secured internal CLI:
   ```javascript
   const request = await financialSecurityService.createApprovalRequest({
     operationType: 'MANUAL_REFUND', // or 'MANUAL_ADJUSTMENT', 'ESCROW_FORCE_RELEASE'
     payload: {
       paymentId: 'pay_test_019283',
       customerId: 'cust_abc123',
       refundPaise: 750000, // ₹7,500
       reason: 'Customer dispute chargeback agreement - Ticket #VAAYU-8821'
     },
     amountPaise: 750000,
     reason: 'Customer dispute chargeback agreement - Ticket #VAAYU-8821',
     requestedBy: 'operator_priya_fin',
     requestedByRole: 'FINANCE_REFUND'
   });
   ```
3. **Notify Approver Pool**: Post the generated `requestId` (UUID) to the authorized checker channel. **Do not attempt to approve your own request.**

---

## 5. Phase 2 — Checker Procedure (Verification & Decision)

The designated checker (e.g., Finance Lead or Super Admin) performs independent due diligence:

### Step 1: Inspect Pending Approvals
```sql
SELECT 
    request_id,
    operation_type,
    amount_paise,
    reason,
    requested_by,
    requested_by_role,
    status,
    created_at
FROM financial_approval_requests
WHERE status = 'PENDING'
ORDER BY created_at ASC;
```

### Step 2: Validate Separation of Duty
- Confirm `decidedBy !== requested_by`.
- Confirm user role contains appropriate checker permissions (`SUPER_ADMIN` or authorized supervisor role).

### Step 3: Verify Cross-System Artifacts
- Check gateway dashboard: Confirm whether the customer was already debited or refunded.
- Run trace query:
  ```bash
  curl -X GET "http://127.0.0.1:4000/api/admin/financial/trace?paymentId=pay_test_019283" \
    -H "Authorization: Bearer $FINANCE_TOKEN"
  ```
- Confirm ledger balance will not breach minimum reserve or allow unauthorized negative balance.

### Step 4: Execute Decision
Call `financialSecurityService.decideApprovalRequest()`:

**To Approve:**
```javascript
const result = await financialSecurityService.decideApprovalRequest({
  requestId: '4a1b0c99-0d12-4e56-9a01-bcdef0123456',
  decision: 'APPROVED',
  decisionNotes: 'Verified ticket #VAAYU-8821 and bank reference UTR-991823. Approved.',
  decidedBy: 'lead_vikram_admin',
  decidedByRole: 'SUPER_ADMIN'
});
```
*Note*: Upon approval, the underlying service automatically executes the double-entry transaction and appends the immutable audit entry within the same database transaction.

**To Reject:**
```javascript
const result = await financialSecurityService.decideApprovalRequest({
  requestId: '4a1b0c99-0d12-4e56-9a01-bcdef0123456',
  decision: 'REJECTED',
  decisionNotes: 'Duplicate refund attempt detected for payment pay_test_019283. Rejected.',
  decidedBy: 'lead_vikram_admin',
  decidedByRole: 'SUPER_ADMIN'
});
```

---

## 6. Phase 3 — Verification & Audit Trail

Confirm that the audit log reflects the dual-party involvement:

```sql
SELECT 
    audit_id,
    action,
    entity_type,
    entity_id,
    performed_by,
    performed_by_role,
    metadata->>'decision' as decision,
    metadata->>'requestedBy' as requested_by,
    created_at
FROM financial_audit_trail
WHERE entity_id = '4a1b0c99-0d12-4e56-9a01-bcdef0123456'
ORDER BY created_at ASC;
```

Expected result: Two entries logged:
1. `APPROVAL_REQUESTED` by `operator_priya_fin`.
2. `APPROVAL_DECIDED` by `lead_vikram_admin` with `APPROVED` or `REJECTED`.

---

## 7. Prohibited Actions (Stop Conditions)

> [!CAUTION]
> 1. **NO SELF-APPROVAL**: Never share credentials or execute approvals with the same user ID as the requester. Attempting this triggers an automatic security event and revokes active sessions.
> 2. **NO DIRECT BALANCES MUTATION**: Never update `user_balances` or `driver_balances` directly to satisfy an approval. All adjustments must flow through double-entry `ledger_journal_entries`.
> 3. **NO BLIND BATCH APPROVALS**: Every request above threshold must have independent external evidence referenced in `decisionNotes`.
