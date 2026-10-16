# VAAYU KYC & Document Verification Architecture

## Objective

KYC must reject fabricated, handwritten and self-created document claims rather than merely extracting text. No OCR result is treated as proof of authenticity.

## Decision pipeline

`Camera capture -> quality/liveness/document classification -> handwriting/synthetic-content signals -> OCR/field extraction -> internal uniqueness/ownership -> cross-document consistency -> authoritative issuer verification -> fraud/risk policy -> decision`

Possible decisions:

- `VERIFIED`: authoritative issuer verification matched and all mandatory policy checks passed.
- `REJECTED`: known duplicate, ownership conflict, handwritten/self-created content, authoritative mismatch, expired/invalid document, or other hard-fail rule.
- `RETAKE`: capture quality/layout is insufficient to make a reliable decision.
- `HUMAN_REVIEW`: suspicious or ambiguous case where automatic evidence is insufficient.
- `PENDING_PARTNER_ACCESS`: the document type requires an external authoritative source that VAAYU has not yet been enabled for.

## Handwritten-paper rule

A user showing paper with a handwritten RC number, DL number, policy number or similar value must never become verified merely because OCR can read the number.

Handwriting detection is a risk signal, not a standalone authenticity proof. The production engine should combine:

1. OCR text geometry and character confidence.
2. Stroke/edge/layout characteristics when supported by the vision model.
3. Expected document layout and security-feature regions.
4. Presence of issuer/machine-readable structure.
5. Capture quality, perspective and screen/print artefact detection.
6. Document-specific required fields.
7. Internal duplicate and ownership rules.
8. Authoritative issuer match.

A handwritten capture with no authoritative digital issuer match is rejected, not verified.

## Dynamic identity rules

- Vehicle/RC registration number: globally unique within VAAYU's active fleet registry.
- RC chassis/engine identifiers: unique according to the vehicle identity policy.
- Driving licence number: person-bound, not vehicle-bound. The same driver may associate the same licence with multiple vehicles they are legitimately operating; another driver cannot claim the same licence identity.
- Insurance policy number: unique; vehicle number must match the policy where the provider supplies that field.
- PAN: identity-bound and unique under the applicable verification policy.
- Aadhaar last four digits: never used as a uniqueness key.
- Profile photo: no document-number uniqueness rule.

Uniqueness checks are advisory until backed by database constraints/transactional ownership locks. The final implementation must be race-safe under concurrent KYC submissions.

## Authoritative provider strategy

VAAYU uses a provider-neutral adapter boundary. Credentials and endpoints are environment configuration; no government portal scraping is permitted.

### Preferred order

1. **DigiLocker / API Setu** for consented issuer documents where the required document is available. DigiLocker explicitly supports verified requester partners and API-based document access. It uses consent-driven exchange and digitally signed issuer documents. 
2. **MoRTH / Vahan / Sarathi through an authorized API/API Setu route** for transport-specific RC, DL and insurance verification when VAAYU receives the necessary approval and credentials.
3. **UIDAI-authorized or offline-verification route** for Aadhaar only, subject to the applicable requesting/offline verification entity requirements and explicit consent.
4. **Authorized PAN verification provider/API Setu collection** for PAN.

The provider registry must not silently downgrade from authoritative verification to OCR. If no authoritative source is available, the result remains `PENDING_PARTNER_ACCESS` or `HUMAN_REVIEW`, depending on risk policy.

## Plug-and-play configuration

Providers are disabled by default and are enabled only after legal/commercial onboarding:

- `DOCUMENT_PROVIDER_DIGILOCKER_ENABLED`
- `DIGILOCKER_API_BASE_URL`
- `DOCUMENT_PROVIDER_MORTH_ENABLED`
- `MORTH_API_BASE_URL`
- `DOCUMENT_PROVIDER_PAN_ENABLED`
- `PAN_VERIFICATION_API_BASE_URL`
- `DOCUMENT_PROVIDER_AADHAAR_ENABLED`
- `AADHAAR_VERIFICATION_API_BASE_URL`

Secrets must be injected through the deployment secret manager/environment, never committed.

## Provider response contract

Every adapter must normalize its response to:

```text
state: VERIFIED_MATCH | VERIFIED_REJECTED | UNAVAILABLE | PENDING_PARTNER_ACCESS
provider: stable provider name
verificationId: provider transaction/reference id
issuer: normalized issuer identity
matchedFields: fields confirmed by issuer
mismatchedFields: fields rejected by issuer
verifiedAt: server timestamp
rawEvidenceHash: hash of retained evidence, when applicable
```

Provider-specific response formats must never leak into domain/business logic.

## Security and privacy

- Never scrape government portals or automate citizen sessions/CAPTCHAs.
- Obtain and record required user consent before provider calls.
- Minimize stored PII.
- Store only masked Aadhaar identifiers where possible; use supported offline e-KYC/authorized flows when Aadhaar verification is required.
- Keep provider credentials outside source control.
- Audit every verification attempt, decision and reviewer action.
- Use immutable evidence hashes for integrity; do not describe SHA-256 as a digital signature.
- Retain original documents only according to the finalized legal/retention policy.

## Commercial activation

The codebase is built so the verification engine can be activated later by plugging in approved credentials/configuration and implementing the provider adapter's request mapping. Until then, the system remains truthful: it can perform structural extraction, duplicate checks and risk assessment, but it must not claim an official document is genuine without authoritative evidence.
