# SOP-FIN-02: Handling Amount Mismatch & Suspected Gateway Payload Tampering

**Document Code**: SOP-FIN-02  
**Target Subsystem**: VAAYU Financial Subsystem / Ingestion & Reconciliation  
**Applicability**: Finance Operations, Risk & Fraud Analysts, Security Response Team  
**Effective Date**: 2026-10-13  
**Frozen Architectural Boundaries**: Core accounting model is strictly FROZEN. *Never force-settle or edit ledger amounts.*

---

## 1. Trigger & Severity Classification

### Trigger
A discrepancy of type `AMOUNT_MISMATCH` is flagged by `PaymentIngestionService` or logged in `payment_discrepancy_records`.

### Condition
The funds captured or authorized at the gateway do not match the expected integer paise amount recorded in `payment_provider_mappings.expected_amount_paise`.
*Example*: Internal expected fare = ₹500.00 (50,000 paise); Gateway captured amount = ₹400.00 (40,000 paise) or ₹50.00 (5,000 paise).

### Severity
- **P1 (Critical / Security Alert)**: Any amount mismatch is treated as a security event until proven otherwise (potential client tampering, currency conversion exploit, or gateway parameter tampering).

---

## 2. Immediate Containment

1. **STOP AUTO-HEALING**: The automated reconciliation worker deliberately does NOT auto-heal `AMOUNT_MISMATCH`. Do NOT override this safeguard.
2. **FREEZE PAYMENT**: The payment transaction must remain in `INITIATED` or `DISPUTED`. It must NEVER transition to `ESCROWED` or `SETTLED`.
3. **NOTIFY DISPATCH**: Block the delivery driver settlement until the fare source is authenticated.

---

## 3. Evidence Collection

Collect the following forensic artifacts:
- Webhook raw payload and signature from `payment_provider_events`.
- Provider order ID (`provider_order_id`) and payment ID (`provider_payment_id`).
- Fare calculation breakdown from `payment_transactions` and quote records.

### Forensic Query (Read-Only)
```sql
SELECT e.event_pk, e.provider_event_id, e.event_type, e.signature,
       e.amount_paise as provider_captured_paise,
       m.expected_amount_paise as internal_expected_paise,
       m.trip_id, m.customer_id, m.status, e.raw_payload
FROM payment_provider_events e
JOIN payment_provider_mappings m ON m.payment_id = e.matched_payment_id
WHERE m.payment_id = $1;
```

---

## 4. Diagnostic Procedure

### Step 1: Verify Cryptographic Signature
Confirm whether the webhook signature verified or if this was an API-reconciled mismatch:
```sql
SELECT status, processing_error
FROM payment_provider_events
WHERE matched_payment_id = '<paymentId>';
```
If `status === 'FAILED'` and error mentions `Cryptographic signature verification failed`, payload was forged. Mark as **MALICIOUS_ATTEMPT**.

### Step 2: Gateway Dashboard Cross-Verification
1. Log into Razorpay Dashboard.
2. Search for the payment ID (`pay_...`).
3. Check the exact charged amount, currency, and notes attached.
4. Verify if customer initiated a partial payment or used an unauthorized discount code at gateway level.

### Stop Conditions:
- **Never force-settle**: Do not settle the trip for the lower amount without driver consent and explicit Four-Eyes approval.
- **Never alter ledger history**: Do not edit `amount_paise` in `payment_transactions`.

---

## 5. Authorized Remediation Procedure

### Scenario A: Legitimate Customer Underpayment (Tampered Client / Exploit)
The customer manipulated the frontend to pay less than the agreed fare.
1. **Cancel the trip** with driver compensation protection.
2. **Refund the underpaid amount** back to customer on the gateway:
   - Use `razorpay.refundPayment({ providerPaymentId, amountPaise })`.
3. **Record Discrepancy Resolution**:
   - Status: `RESOLVED_MANUAL`
   - Action: `REFUNDED_GATEWAY_TAMPER_DETECTED`
   - Notes: "Customer underpaid by ₹X; refunded at gateway, trip cancelled."

### Scenario B: Valid Promo / Fare Adjustment Approved by Ops
If a legitimate backend discount was omitted from the provider mapping:
1. Operator creates a Four-Eyes Adjustment Request (`MANUAL_ADJUSTMENT`) via **SOP-FIN-04**.
2. Dual-control manager approves.
3. System posts compensating ledger entry to `platform:expense:promotions` to balance the difference.

---

## 6. Verification & Closure

1. Re-query trace:
```http
GET /api/admin/financial/trace?payment_id=<paymentId>
```
2. Inconsistencies count must be 0.
3. Status in `payment_discrepancy_records` must be `RESOLVED_MANUAL`.
4. Audit log entry created in `financial_audit_trail`.

---

## 7. Escalation & Recovery Directory

- **Lead Contact**: Head of Fraud Prevention & Security
- **Operational Escalation**: Chief Technology Officer / Principal Architect
