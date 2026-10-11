# VAAYU Logistics Platform

VAAYU is a Hyderabad-focused intra-city logistics platform. The current repository contains a Node.js backend, customer and merchant portals, an operations console, a fleet portal, a driver web app, and a collection of platform verification suites.

## Current layout

```text
apps/backend/src/server_production.js  Integrated HTTP API and static portal host
apps/backend/src/map-engine/           Isolated routing, search, geocoding, route quality, and ETA core
apps/backend/src/services/             Auth, dispatch, route/fare, telemetry, SLA, etc.
apps/backend/src/db/                   JSON and persistence adapters
apps/backend/public/                   Customer, admin, merchant, fleet and tracking UIs
apps/backend/public/driver/            Driver web application
scratch/                               Focused platform verification suites
docker-compose.yml                     Local Postgres/PostGIS and Redis containers
```

The older Express/Socket.IO starter remains available as `server.ts`. It is a separate demo implementation and does not provide all routes in `server_production.js`.

## Run the integrated local demo

On this Windows laptop, run from `apps/backend`:

```powershell
.\start-local-demo.ps1
```

The launcher uses the bundled Node.js 22 runtime when available, binds only to `127.0.0.1`, and reuses a persistent SQLite demo replica under the Windows Temp directory. It reports the local links for the customer, admin, merchant, driver, fleet, and public tracking pages. Use `Ctrl+C` to stop it. To use another isolated database or port, pass `-DatabasePath` and `-Port`.

The launcher loads local admin accounts from `apps/backend/.env`; each account's password stays there and is never shown in the app. The admin role shortcuts only preselect an account. Customer, driver, merchant, and fleet demo users sign in using local development OTPs, which the app fills automatically. The local OTP codes are not sent to a real phone.

### Start a fresh, repeatable demo

To start from the default seeded data without touching the persistent demo database, run:

```powershell
.\start-clean-local-demo.ps1
```

This creates a new, uniquely named SQLite database in the Windows Temp directory and starts the local demo on port 4128. Each run is independent; use a different `-Port` if 4128 is occupied. Stop the server with `Ctrl+C`. The temporary database is retained so you can restart that same demo later with `.\start-local-demo.ps1 -Port 4128 -DatabasePath '<printed database path>'`.

For a basic end-to-end walkthrough:

1. Open the customer page and use **1-Tap Quick Demo Login** with `9876543210`.
2. Search a Hyderabad pickup and drop, choose a vehicle, and place a cash-on-delivery booking.
3. Open the driver page and sign in with `9123456789`; go online, accept the offered booking, and complete pickup and delivery with the displayed local OTPs. For a 2W booking, sign in with the demo 2W driver `9000000001`.
4. Open the customer tracking page or the tracking link from the booking to confirm status and fare/payment wording.
5. Sign in to Admin using a configured account from `.env`; verify the trip and driver state in the operations dashboard. Admin changes made in this clean run stay in its temporary database.

Merchant (`9849988776`) and fleet owner (`9555544444`) accounts use the same local OTP sign-in. The demo 2W driver (`9000000001`, Kiran Demo) is seeded online with an approved demo profile so 2W dispatch can be exercised. Admin account names and roles are listed in `.env`; passwords remain private there.

### Verify the local demo

From `apps/backend`, run the maintained workflow checks with the bundled Node.js runtime:

```powershell
$env:VAAYU_QA_BASE_URL = 'http://127.0.0.1:4147'
& '.\.local-tools\node-v22.23.3-win-x64\node.exe' '..\..\scratch\verify_local_demo_workflows.js'
```

The runner starts a separate server and fresh SQLite database for each suite, enables test-only reset routes only on those isolated servers, and leaves the persistent demo database alone. It covers customer booking/dispatch/cancellation/history, driver availability and GPS, merchant batch bookings, fleet ownership and vehicle assignment, location search and routing, and authenticated Admin dashboard, role boundaries, dispatch, KYC, fleet, support, dispute, payout, rejection and settings workflows. Browser checks cover all six portals at 1440×1000 and 390×844, with customer, merchant, driver and fleet sign-in; a merchant three-vehicle booking; a complete driver delivery journey; reversible Admin driver status and KYC changes; an Admin invalid-credential check; and authenticated Super Admin navigation through every available module. Authenticated and initial-state screenshots are saved to a timestamped folder under `%TEMP%`. The isolated QA server has higher default-route and OTP-send ceilings to let every workflow finish in one run; these overrides require test endpoints in a non-production process, so normal demo/production rate limits are unchanged.

The maintained checks verify critical workflows and selected error/permission cases. They are not an assertion that every visible control has been manually exercised; complex third-party integrations, real payment processing, real SMS delivery, and deployed cloud behavior remain outside the local demo.

See [`scratch/LOCAL_DEMO_FEATURE_MATRIX.md`](scratch/LOCAL_DEMO_FEATURE_MATRIX.md) for the portal-by-portal verification status and remaining local-demo checks.

### Seeded local demo accounts

| Portal | Demo identity | Sign-in |
| --- | --- | --- |
| Customer | `9876543210` | Use **1-Tap Quick Demo Login** or request a local OTP. |
| Driver | `9123456789` | Request and auto-fill the local OTP. |
| Merchant | `9849988776` | Request and auto-fill the local OTP. |
| Fleet owner | `9555544444` | Request and auto-fill the local OTP. |
| Admin | `admin@vaayu.in`, `support@vaayu.in`, `dispatch@vaayu.in` | Use the matching password configured in `.env`; the role cards select the account. |

`npm run dev` also starts the integrated server using the `PORT`, `HOST`, and `DATABASE_PATH` values in `.env` (4000 and `apps/backend/local-data/vaayu-dev.sqlite` in `.env.example`). Use `npm run dev:starter` only when you specifically want the smaller Express/Socket.IO starter; it does not serve all the integrated portal features.

### Test from a phone on the same Wi-Fi

From PowerShell, start a clean, disposable demo database and bind the integrated server to the laptop's Wi-Fi/Ethernet interfaces:

```powershell
cd apps/backend
.\start-phone-demo.ps1
```

The launcher prints the laptop's LAN URL and links for Customer, Driver, Merchant, Fleet, Admin, and tracking. Open those links on the phone while it is connected to the same private Wi-Fi as the laptop. The phone and laptop must remain on that network, the launcher window must remain open, and the laptop must stay awake. The generated SQLite file is placed under the Windows temporary directory; stop the server with Ctrl+C. To use a different port, run `.\start-phone-demo.ps1 -Port 4130`.

Mobile browsers only expose device GPS to secure contexts. The LAN demo currently uses HTTP, so current-location GPS will not work from a phone at the laptop's private IP. Use the pickup search and select a result, drag the map pin, or choose a saved pickup; the app now explains the HTTPS requirement and blocks submitting the unconfirmed map default as the pickup. Device GPS on a phone needs a trusted HTTPS setup.

If Windows Firewall blocks the phone, allow the selected TCP port only on the **Private** profile. In an elevated PowerShell window, replace `4128` if you chose another port and run:

```powershell
New-NetFirewallRule -DisplayName "VAAYU phone demo (TCP 4128)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4128 -Profile Private
```

Remove that rule after testing with `Remove-NetFirewallRule -DisplayName "VAAYU phone demo (TCP 4128)"`. Do not configure router port forwarding or expose this development server to the public internet. The local demo exposes simulated OTPs and uses seeded demo accounts; payments remain simulated. If the phone cannot reach the URL after the firewall rule, check that both devices are on the same non-guest Wi-Fi and that the access point does not isolate wireless clients.

The local demo simulates OTP delivery, wallet top-ups, and driver payout requests. It does not collect payments or transfer money. Map tiles, address search outside the built-in Hyderabad landmarks, and third-party fonts/scripts may require an internet connection.

## Security configuration

- `JWT_SECRET`: required in production; use a random value of at least 32 characters.
- `VAAYU_ADMIN_USERS_JSON`: JSON array of admin account objects with `username`, `password`, and `role`. Supported roles are `SUPER_ADMIN`, `ADMIN`, `FLEET_ADMIN`, `DISPATCH_OPERATOR`, and `SUPPORT_AGENT`.
- `OTP_DELIVERY_WEBHOOK_URL`: HTTPS endpoint that receives `{ phone, code, expiresInSeconds }`; responses must be 2xx. The server signs the request body with `OTP_DELIVERY_WEBHOOK_SECRET` in `X-VAAYU-Signature`.
- `CORS_ALLOWED_ORIGINS`: comma-separated exact origins. In production, configure the deployed portal origins.
- `ENABLE_TEST_ENDPOINTS=true`: enables destructive test reset endpoints; keep unset outside isolated test environments.

KYC uploads are written under `apps/backend/private_uploads/driver_documents` and served through an authenticated document endpoint. Do not expose that directory from a web server or static hosting layer.

## Important implementation boundary

The SQLite adapter stores the full development/demo state in one transactional row to support the existing synchronous JSON-oriented service layer. It is intended for a single local development server. The checked-in Postgres adapter still contains an in-memory SQL fallback, so selecting it should not be treated as proof of durable production Postgres persistence. Production deployment needs a verified durable repository and external provider credentials for OTP and payment processing. Payment remains behind a deferred provider interface until a real gateway is configured.

The driver app includes demo/simulation UI and its own local helper files. The integrated backend is the source of truth for authenticated customer, driver, merchant, and admin API operations.
