# VAAYU Pre-Launch Checklist

Status as of the last verification run. Code items are done unless marked otherwise.
Items marked **Needs you** require an account, a decision, or an elevated shell.

## 1. Needs you: accounts and providers

| Item | What to provide | Set in environment |
|---|---|---|
| SMS / OTP delivery | Webhook endpoint from an SMS provider (HTTPS) and a shared secret of at least 32 characters | `OTP_DELIVERY_WEBHOOK_URL`, `OTP_DELIVERY_WEBHOOK_SECRET` |
| Managed PostgreSQL | Connection string with backups enabled | `DATABASE_URL` (production database `vaayu`, never shared with staging) |
| Managed Redis | Connection string with a password | `REDIS_URL` |
| Map services | Self-hosted or paid endpoints for routing, geocoding and place search | `OSRM_BASE_URL`, `PHOTON_BASE_URL`, `NOMINATIM_BASE_URL` |
| Domain and TLS | Domain name and a reverse proxy in front of the app on port 4000 | `TRUST_PROXY=true` once behind a proxy |
| Legal | Privacy policy, terms, and processor approval | Not environment; published on the site |

Until the SMS webhook is set, production login returns `503 OTP_NOT_CONFIGURED`. This is intentional: the system fails closed rather than sending codes nowhere.

## 2. Needs you: laptop hosting

- **Auto-start for PostgreSQL and Redis.** Run `scratch\register_services.ps1` from an elevated PowerShell (Run as administrator). Without it, both stop on reboot or crash.
- **Keep the laptop awake.** Disable sleep and hibernate while the server is public, or the site goes offline.

## 3. Needs you: secrets and credentials

- Move `scratch\secure\admin_passwords_*.json` into a password manager, then delete the file.
- Confirm admin passwords are stored only in `VAAYU_ADMIN_USERS_JSON`, never in the repository.
- Decide whether to keep any QA test account per role. The default is none.
- Production refuses to start without `JWT_SECRET` (at least 32 characters), `VAAYU_ADMIN_USERS_JSON`, and PostgreSQL configured.

## 4. Needs you: a visual check

- Log in at `/admin.html` and open **Driver KYC & Fleet**. Confirm the **Pending driver applications** panel shows, and that Approve and Reject behave as expected.
- Walk through the driver sign-in and registration form once in a real browser.

## 5. Done and verified

- Demo data removed from every portal, the seed, and the store.
- OTP flow: send, verify, cooldown, attempt limits, and admin console. 14/14 on staging.
- Driver self-registration with admin review. 16/16 on staging.
- Driver application reject path, including the required reason. 12/12 on staging.
- Trip lifecycle end to end. 27/27 on staging.
- Inline handlers removed from the driver app. `script-src` no longer allows `'unsafe-inline'`, and `script-src-attr` is `'none'`.
- All seven pages load with no CSP violations.
- Security headers, a 1 MB request body cap, Redis-backed rate limiting, and allowlisted static serving.
- Wallet top-up returns 503. Payment gateway and RazorpayX payouts stay disabled.

## 6. Known gaps (not launch blockers)

- Style policy is strict: `style-src` no longer allows `'unsafe-inline'`, and `script-src` and `script-src-attr` are also strict. All inline `<style>` blocks, `style=` attributes, and Leaflet pin styles were moved to `/built/portal.css` or set through CSSOM. A scan of the served portal files finds zero inline styles. Verified on all seven pages with no violations.
- Not yet verified with live data: the driver shift-bar width on a real earnings card, and the booking and tracking maps with a real trip. These need a signed-in driver and a real trip, which I did not fake.
- Editable portal source: the built portal bundles remain the served copy. Future edits go through the bundles or the pre-build copies in `scratch\`. Making the portal source the single editable copy is a maintainability task, not a launch blocker.
- Realtime push is not served by the production server. The driver app uses REST polling.
- Azure deployment and the live payment gateway are out of scope for now.

## 7. Launch-day order

1. Set the managed database, Redis, OTP webhook, and map endpoints in the production environment.
2. Start production and confirm `/api/health` reports PostgreSQL and the database is connected.
3. Send one real OTP to an operator phone and verify it end to end.
4. Run the lifecycle check against staging, not production, so no test records reach production.
5. Put the reverse proxy and TLS in front, set `TRUST_PROXY=true`, and confirm the public URL loads with no console errors.
