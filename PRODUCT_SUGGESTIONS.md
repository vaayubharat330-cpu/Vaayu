# VAAYU Product Suggestions

Non-design suggestions for the next certification pass. Visual design and templates are intentionally omitted.

1. **Make test data disposable by default.** Give PostgreSQL and Redis test suites dedicated containers/namespaces, require explicit test-only endpoints, and make the aggregate runner refuse production/shared URLs before it clears keys or seeds data.
2. **Add browser-driven role workflows.** With seeded accounts and an isolated backend, certify customer booking/OTP/dispatch/tracking, merchant batch booking, admin interventions, and driver pickup/delivery. Assert visible outcomes, API state, and browser console/network errors.
3. **Add failure and concurrency drills.** Exercise Redis/PostgreSQL loss mid-request, concurrent acceptance of one offer, duplicate payments/webhooks, restart recovery, and outbox delivery against disposable infrastructure.
4. **Certify mobile on real devices.** Cover Android and iOS camera permissions, denied/revoked permissions, OCR on representative documents, upload retry/idempotency, offline recovery, and app resume after process death.
5. **Set and continuously test the Flutter SDK floor.** The regenerated lock now requires Flutter `>=3.41.0`, but `pubspec.yaml` does not declare a Flutter minimum and the earlier lock recorded `>=3.38.4`. Decide whether to preserve the older floor with compatible dependency pins or intentionally raise the minimum, then test that exact SDK in CI.
6. **Clear analyzer infos incrementally.** Add braces in `document_field_extractor.dart` and use package imports in the Flutter tests; keep analysis warnings/errors as CI failures.
