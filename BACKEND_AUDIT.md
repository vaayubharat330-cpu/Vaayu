# VAAYU Backend Component Audit

This is the component inventory I measured before building further. Figures come from a
dependency trace (`scratch/component_inventory.js`) and from reading the live code. Nothing here
is a judgement from the file names alone.

## 1. What actually runs

The production server is `apps/backend/src/server_production.js`. It loads 38 files, all of which
resolve, with no broken requires. That is the only backend in use.

| Layer | Live | Notes |
|---|---|---|
| HTTP server | `server_production.js` (raw `http`) | Hand-written router, no framework |
| Auth | `services/authService.js`, admin logic in `server_production.js` | JWT (HS256) and admin users from env |
| Persistence | `db/database.js` → `pgBackedStore.js` → `pgRecordStore.js` → `postgresClient.js` | Per-record PostgreSQL; JSON and SQLite fallbacks |
| Rate limit / locks | `redisRateLimiter.js`, `redisLockManager.js`, `redisClient.js` | Redis, fails closed in production |
| Dispatch / trips | `dispatchService.js`, `deliveryStateMachine.js`, `driverLocationService.js` | Core business logic |
| OTP | `otpChallengeService.js` (login and registration), `otpService.js` (trip PINs) | Two OTP systems; see finding F4 |
| Maps | `map-engine/*`, `routingService.js`, `locationSearchService.js` | OSRM, Photon, Nominatim |
| Payments | `paymentProvider.js`, `fareService.js` | Gateway off; RazorpayX disabled |
| Observability | `logger.js`, `metricsService.js` | Structured logs, metrics |

## 2. What is dead code

52 files under `src/` are never loaded by the production server:

- **Whole modular TypeScript tree**: `src/app.ts`, `src/server.ts`, `src/modules/*` (about 40 route
  and service files), `src/middleware/*`, `src/config/*`, `src/lib/prisma.ts`, `src/utils/csv.ts`.
- **Two security files I had described as working**: `middleware/security.ts` and
  `middleware/adminRoleGate.ts`. The live admin role check is inside `server_production.js`, so the
  role gate I referred to earlier does not run.
- **Seed and migration scripts** that the live path does not use directly.

Also present but unused:

- `prisma/schema.prisma`: 29 models. No live file imports `@prisma/client`.
- `dist/`: a stale compiled copy of an older tree. `dist/server_production.js` is not the running server.
- `node_modules` packages for Prisma, TypeScript, and `ts-node-dev` exist only for the dead tree.

**Decision needed:** delete the dead tree, or finish it and retire the monolith. Keeping both is the
main structural risk, because a fix applied to one will silently not reach the other.

## 3. Findings

Severity: **High** blocks public launch; **Medium** should be fixed before scale; **Low** is hygiene.

| # | Severity | Finding | Evidence |
|---|---|---|---|
| F1 | High | Hardcoded fallback JWT secret in code. Production startup blocks a missing secret, but a code path that bypasses the startup check would sign tokens with a public key. | `authService.js:23` |
| F2 | High | The admin role gate in `adminRoleGate.ts` is dead code. Role enforcement is in the monolith, so it has to be tested there, not assumed. | Dependency trace |
| F3 | High | Two parallel backends and an unused Prisma schema. A security fix in one does not reach the other. | Section 2 |
| F4 | Medium | Two OTP systems (`otpChallengeService` for login, `otpService` for trip PINs) with separate hashing and secrets. | `otpService.js:16`, `otpChallengeService.js:43` |
| F5 | Medium | `OTP_HASH_SECRET` falls back to `JWT_SECRET`. Rotating the JWT secret would invalidate every pending OTP, and one leaked secret exposes both. | `otpChallengeService.js:43` |
| F6 | Medium | Realtime (`websocketService.js`, Socket.io) is loaded but not served by the monolith. Driver app polls over REST. | Earlier audit |
| F7 | Medium | No automated test suite in the repository. Verification has been ad hoc harness scripts under `scratch/`. | Repository layout |
| F8 | Medium | No CI pipeline, no lint, no dependency-audit gate. | Repository layout |
| F9 | Low | `dist/` and `node_modules` for unused stacks inflate the deploy surface. | Section 2 |
| F10 | Low | Dockerfile exists but has never been built or run. Docker is not installed on this machine. | Dockerfile |

## 4. Enterprise baseline: what is present and what is missing

| Area | Status | Gap |
|---|---|---|
| Secrets from environment | Present | No secret manager; `.env` on disk |
| Startup validation | Present | Covers JWT, admin users, DB; not all env vars |
| Authentication | Present | Single HS256 secret, no key rotation, no refresh tokens |
| Authorization | Present, untested in isolation | No automated permission matrix |
| Input validation | Partial | `zod` is installed but the live path does its own checks |
| Rate limiting | Present (Redis) | Only on some routes |
| Audit log of admin actions | Partial | Not verified as complete |
| Backups and restore | Missing | Not tested for production DB |
| Automated tests | Missing | Only scratch harnesses |
| CI / lint / dependency scanning | Missing | None configured |
| Container build | Unverified | Docker not installed |
| Monitoring and alerting | Partial | Metrics exist; no alert destinations |
| Error tracking | Missing | Logs only |
| Environment separation | Present | Staging and production use separate databases |
| Documentation | Partial | `DEPLOYMENT.md`, `PRELAUNCH_CHECKLIST.md`, this file |

## 4a. Status after the first fix pass

- **Archived** the dead TypeScript tree, `dist/`, and the Prisma schema to
  `scratch/archive/backend_dead_*` (reversible, with README). `package.json` scripts and unused
  dependencies removed. Production dependencies: 0 known vulnerabilities.
- **F1 fixed:** no fallback JWT secret. A missing or short secret now fails closed in every environment.
- **Auth hardened:** HS256 pinned for sign and verify; query-string tokens refused.
  `scratch/check_auth_hardening.js`: 6/6 pass.
- **F5 fixed:** OTP hashing uses a dedicated `OTP_HASH_SECRET` (≥32 chars). No longer derived from
  `JWT_SECRET`, in both OTP services.
- **Secrets rotated:** `JWT_SECRET` replaced (the old value was the public development string that
  was also in code). Old `.env` backed up to `scratch/secure/`. Existing sessions are invalidated.
- Lifecycle suite 27/27 on staging after the change. Production and staging restarted.

## 4b. Status after the second pass (tests, CI, backup)

- **Backup and restore drill:** `scratch/backup_restore_drill.ps1` dumps the production database
  (`pg_dump` 18.6, matching the server), restores it into a throwaway database, and compares row
  counts. Result: 19 rows source, 19 restored. PASS. PostgreSQL client tools installed via winget.
- **Unit tests:** `npm test` runs `test/unit/security.test.js` and `test/unit/otp.test.js` (Node's
  built-in runner). 10/10 pass. Covers token signing, algorithm pinning, header-only auth, expiry,
  the required secret, and OTP hashing independent of the JWT secret.
- **CI:** `.github/workflows/ci.yml` with two jobs. `backend` runs syntax checks, unit tests, and a
  production dependency audit that fails on high or critical. `portals` runs the bundle build and a
  parse check. Workflow parses (2 jobs). It has not run on GitHub yet, because the project is not
  yet a pushed repository.
- **Still not in CI:** the end-to-end suites (`run_lifecycle.js`, OTP, driver registration). They
  need a live PostgreSQL and Redis, which CI runners don't have. They stay as a manual gate until a
  managed test database exists.
- **Gap noted:** portal JSX has no editable source in the repo (the `text/babel` blocks were
  replaced by the build). The `portals` CI job checks that the bundles compile, but cannot protect
  the readable source. This is the style-policy follow-up.

## 5. Recommended order

1. **Decide the single backend.** The recommendation is to keep the monolith (it is the one that runs
   and is verified) and delete the dead TypeScript tree and the unused Prisma schema. Finishing a
   second backend would take far longer than the launch needs.
2. **Remove the hardcoded fallback secret (F1)** and fail closed when `JWT_SECRET` is absent, in every
   code path.
3. **Unify the OTP secret (F5)** with a dedicated `OTP_HASH_SECRET` that is required, not derived.
4. **Add an automated test suite and CI (F7, F8)**, turning the scratch harnesses into repeatable tests.
5. **Build and run the container (F10)**, which needs Docker installed.
6. **Backup and restore drill** for the production PostgreSQL database.

I'll wait for your decision on item 1 before deleting anything, because removing 52 files cannot be
undone without the backup.
