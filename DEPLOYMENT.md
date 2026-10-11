# VAAYU Deployment Guide

This guide covers running the VAAYU backend in production. The production entry point is `apps/backend/src/server_production.js`. It serves the customer, driver, merchant, fleet, and admin portals and the `/api` routes from one process.

## 1. Prerequisites

- Node.js 20 or newer
- PostgreSQL 14 or newer (the system of record)
- Redis 6 or newer (rate limiting)
- HTTPS termination in front of the app (reverse proxy or load balancer)
- An OTP delivery webhook (SMS provider adapter) that accepts signed HTTPS requests
- Self-hosted or paid map services for routing and geocoding (OSRM, Photon, Nominatim)

## 2. Install

```
cd apps/backend
npm ci --omit=dev
```

## 3. Configure

Copy `apps/backend/.env.example` to `apps/backend/.env` and set these values. In production the server refuses to start without `JWT_SECRET`, `VAAYU_ADMIN_USERS_JSON`, and PostgreSQL. The OTP webhook is checked when a code is sent: without it, sign-in returns 503 rather than failing silently.

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `PERSISTENCE_PROVIDER` | yes | `postgres` |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_URL` | yes | Rate-limit store. Fails closed in production if unavailable. |
| `JWT_SECRET` | yes | At least 32 characters, random |
| `OTP_HASH_SECRET` | yes | Random, separate from `JWT_SECRET` |
| `OTP_DELIVERY_WEBHOOK_URL` | yes | HTTPS endpoint of the SMS adapter |
| `OTP_DELIVERY_WEBHOOK_SECRET` | yes | At least 32 characters |
| `VAAYU_ADMIN_USERS_JSON` | yes | Admin accounts. Store the passwords in a password manager. |
| `CORS_ALLOWED_ORIGINS` | yes | Exact portal origin, e.g. `https://app.example.com` |
| `TRUST_PROXY` | yes | `true` only behind your reverse proxy |
| `OSRM_BASE_URL`, `PHOTON_BASE_URL`, `NOMINATIM_BASE_URL` | yes | Self-hosted or paid endpoints |
| `VAAYU_EXPOSE_DEV_OTP` | must be unset or `false` | Exposes OTPs. Never enable in production. |
| `ENABLE_TEST_ENDPOINTS` | must be `false` | |
| `RAZORPAY_ENABLED` | `false` | Payments are off for launch |
| `VAAYU_ENABLE_RAZORPAYX_PAYOUTS` | `false` | Real-money transfers stay off |

## 4. Database

Create an empty database. Seed it with structure only (vehicle categories, zones, system settings). Do not seed test drivers, customers, or trips.

```
DATABASE_URL=postgres://... node src/db/seedPostgres.js
```

The seeder refuses a non-empty database unless `--force` is passed. Do not use `--force` on a live store.

Use a separate database for staging. Staging and production must never share a database. Test harnesses write real records.

## 5. Run

```
NODE_ENV=production node src/server_production.js
```

Run it under a process manager (systemd, pm2, or the platform's service runner) so it restarts on failure. Bind to `127.0.0.1` and let the reverse proxy listen on 443.

## 6. Reverse proxy (HTTPS)

- Terminate TLS with a valid certificate.
- Forward to `127.0.0.1:4000`.
- Set `X-Forwarded-For` and `X-Forwarded-Proto`.
- Keep `TRUST_PROXY=true` only when the proxy overwrites client-supplied forwarding headers.
- Set a request body limit no higher than 1 MB for general routes. The server enforces this too.

## 7. Verify after deploy

```
GET /api/health                -> 200, status UP, database CONNECTED
GET /api/auth/otp-display/x    -> 403 (dev OTP display blocked)
GET /api/admin/drivers         -> 401 (admin requires a token)
POST /api/customer/wallet/top-up -> 401 or 503 (payments off)
GET /.env, /package.json       -> 404
```

Check the response headers on `/driver/`: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.

## 8. Known limits before public traffic

- **OTP delivery** depends on your webhook adapter. Without it, sign-in returns 503 by design.
- **Map services** must be self-hosted or paid. Public OSRM, Photon, and Nominatim endpoints have no uptime guarantee.
- **Content Security Policy** still allows inline scripts and CDN Babel. Moving to a bundled build removes this.
- **Driver app** contains null-guarded references to removed elements. They are harmless and do not run.

## 9. Backups and data

- Back up PostgreSQL daily and test restores.
- Keep the seed file and admin credentials out of source control.
- Do not publish the `scratch/` folder or any `secure/` folder.
