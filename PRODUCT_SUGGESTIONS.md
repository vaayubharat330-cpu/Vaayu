# VAAYU Product Suggestions

Non-design suggestions for the next certification pass. Visual design and templates are intentionally omitted.

1. **Make test data disposable by default.** Give PostgreSQL and Redis test suites dedicated containers/namespaces, require explicit test-only endpoints, and make the aggregate runner refuse production/shared URLs before it clears keys or seeds data.
2. **Add browser-driven role workflows.** With seeded accounts and an isolated backend, certify customer booking/OTP/dispatch/tracking, merchant batch booking, admin interventions, and driver pickup/delivery. Assert visible outcomes, API state, and browser console/network errors.
3. **Add failure and concurrency drills.** Exercise Redis/PostgreSQL loss mid-request, concurrent acceptance of one offer, duplicate payments/webhooks, restart recovery, and outbox delivery against disposable infrastructure.
4. **Certify mobile on real devices.** Cover Android and iOS camera permissions, denied/revoked permissions, OCR on representative documents, upload retry/idempotency, offline recovery, and app resume after process death.
5. **Keep the Flutter SDK floor enforced.** `pubspec.yaml` and the lock now declare Flutter `>=3.41.0`; pin that exact supported floor in CI and test it whenever dependencies change.
6. **Clear analyzer infos incrementally.** Replace the seven relative library imports in Flutter tests with package imports, then make analyzer findings visible in CI without treating unrelated info-level guidance as a warning.
7. **Make health/readiness truthful.** Existing issue-register findings note that readiness can be based on environment mode and database status may be reported without a fresh database check. Define separate liveness/readiness contracts and test them with database/cache outages.
8. **Resolve active/stale source ambiguity.** Confirm the root `backend/` duplicate is not shipped or referenced; remove it or label/archive it in a separate reviewed change so security fixes and tests target `apps/backend` unambiguously.
