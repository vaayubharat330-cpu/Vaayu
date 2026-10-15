# VAAYU Financial Subsystem: Operational Runbooks & Standard Operating Procedures (Pillar 4)

**Status**: PRODUCTION-HARDENED / ARCHITECTURALLY FROZEN  
**Target Audience**: Financial Operations, Site Reliability Engineering (SRE), Security Operations, Leadership  
**Scope**: Disaster Recovery, Incident Response, Dual-Control Governance, and Daily Financial Operations

---

## 1. Executive Summary

This repository contains the definitive Operational Standard Operating Procedures (SOPs) for the VAAYU financial core. The financial architecture has been frozen under Phases F.1 through F.7, guaranteeing double-entry ledger balance, transactional outbox durability, distributed advisory locking, and immutable audit logs.

These runbooks dictate how human operators, engineers, and financial auditors interact with the production system during routine anomalies, reconciliation discrepancies, and catastrophic failure events.

> [!IMPORTANT]
> **Cardinal Financial Invariants**:
> 1. **No Direct SQL Mutations**: Under no circumstances may an engineer or operator run `UPDATE` or `DELETE` statements on `ledger_journal_entries`, `ledger_postings`, `financial_audit_trail`, `user_balances`, or `driver_balances`.
> 2. **Double-Entry Remediation Only**: All manual balances corrections, goodwill credits, or chargeback recoveries must be performed using authorized compensating journal entries (`MANUAL_COMPENSATING_ENTRY`) via `financialSecurityService`.
> 3. **Dual-Control (Maker-Checker)**: High-value actions ($\ge ₹5,000$) or balance overrides require two distinct individuals (`requested_by !== decided_by`). Self-approvals are strictly blocked by the system.
> 4. **No Unverified Auto-Healing**: Never force-settle or auto-heal transactions with amount mismatches or currency discrepancies.

---

## 2. Runbook Catalog & Severity Directory

| Runbook ID | Title | Severity | Primary Actor | Action Trigger |
|---|---|---|---|---|
| [**SOP-FIN-01**](file:///C:/Users/suraj/.gemini/antigravity/scratch/vaayu_app/apps/backend/docs/runbooks/SOP-FIN-01-MISSING-INTERNAL-ESCROW.md) | Missing Internal Escrow Investigation | **P2** | Finance Analyst / Ops | Reconciliation reports captured payment without internal escrow |
| [**SOP-FIN-02**](file:///C:/Users/suraj/.gemini/antigravity/scratch/vaayu_app/apps/backend/docs/runbooks/SOP-FIN-02-AMOUNT-MISMATCH-TAMPERING.md) | Amount Mismatch & Suspected Tampering | **P1** | Security / Lead Finance | Ingestion signature mismatch or payload paise discrepancy |
| [**SOP-FIN-03**](file:///C:/Users/suraj/.gemini/antigravity/scratch/vaayu_app/apps/backend/docs/runbooks/SOP-FIN-03-OUTBOX-DLQ-REDRIVE.md) | Outbox Dead-Letter Queue (DLQ) & Redrive | **P2** | SRE / Platform Engineer | Messages in `payment_outbox` reach max retries with `DEAD_LETTER` |
| [**SOP-FIN-04**](file:///C:/Users/suraj/.gemini/antigravity/scratch/vaayu_app/apps/backend/docs/runbooks/SOP-FIN-04-MAKER-CHECKER-APPROVAL.md) | Maker-Checker Financial Approvals | **P2 / P1** | Finance Maker & Checker | Manual refund $\ge ₹5,000$, dispute resolution, or goodwill credit |
| [**SOP-FIN-05**](file:///C:/Users/suraj/.gemini/antigravity/scratch/vaayu_app/apps/backend/docs/runbooks/SOP-FIN-05-DATABASE-FAILOVER-RECOVERY.md) | Database Failover & Financial DR Recovery | **P0** | Lead SRE / Architect | Primary PG crash, PITR recovery, or post-failover ledger verification |

---

## 3. Incident Severity Matrix & SLA

```text
┌──────────┬───────────────────────────────────────────┬───────────────┬───────────────────────────────┐
│ Severity │ Description                               │ Max TTR (SLA) │ Escalation Target             │
├──────────┼───────────────────────────────────────────┼───────────────┼───────────────────────────────┤
│ P0       │ Database down, ledger imbalance, DR event │ 15 minutes    │ VP Eng, Chief Architect, SRE  │
│ P1       │ Amount tampering, payment spoofing        │ 1 hour        │ Lead Security, Head of Ops    │
│ P2       │ DLQ buildup (>50), unescrowed payments    │ 4 hours       │ On-call SRE, Senior Ops       │
│ P3 / P4  │ Routine batch reconciliation discrepancy  │ 24 hours      │ Finance Operations Team       │
└──────────┴───────────────────────────────────────────┴───────────────┴───────────────────────────────┘
```

---

## 4. Operational Tooling & Diagnostic Endpoints

Operators have access to non-destructive observability and tracing tools:

1. **Financial Trace Tool**:
   - `GET /api/admin/financial/trace?paymentId=<ID>`
   - `GET /api/admin/financial/trace?tripId=<ID>`
   - `GET /api/admin/financial/trace?providerEventId=<ID>`
   - Returns complete timeline linking webhook events, idempotency keys, outbox messages, and balanced journal entries.

2. **Anomaly Scanner**:
   - `GET /api/admin/financial/anomalies`
   - Scans for pending outbox backlogs, unbalanced entries, orphaned provider events, and unlinked discrepancies.

3. **Reconciliation Engine CLI**:
   - `node -e "require('./src/services/ledger/paymentReconciliationService').reconcileRecentPayments({ lookbackHours: 24 })"`
   - Executes safe audit matching internal state against payment provider settlement records.

---

## 5. Escalation & Contact Directory

In the event of an unresolved P0 or P1 incident, contact the on-call rota immediately:

- **Incident Commander / Primary SRE**: `sre-oncall@vaayu.internal` | PagerDuty: `PD-SRE-CORE`
- **Financial Architecture Escalation**: `fin-arch@vaayu.internal`
- **Chief Security Officer (Tampering / Fraud)**: `secops@vaayu.internal`
- **Payment Provider Escalation (Razorpay / Bank Ops)**: `support@razorpay.com` (Merchant ID: `rzp_live_vaayu`)

---

## 6. Tabletop Drill Schedule

To maintain disaster preparedness and operational competence:
- **Bi-Weekly**: SOP-FIN-01 & SOP-FIN-03 (Reconciliation discrepancies and DLQ redrive drill).
- **Monthly**: SOP-FIN-02 & SOP-FIN-04 (Simulated tampering defense and dual-control approval cycle).
- **Quarterly**: SOP-FIN-05 (Full database restore, point-in-time recovery, and 12-invariant audit verification).
