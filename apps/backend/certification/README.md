# VAAYU Certification Control Center

Disposable-environment certification and observability layer for VAAYU.

## Safety boundary

This application refuses to start when `NODE_ENV=production` or `VAAYU_TEST_TARGET` is not exactly `disposable`. PostgreSQL and Redis are observed locally; they must never be exposed through the public tunnel.

## Components

- `server.js` — read-only Control Center HTTP server.
- `public/index.html` — live dashboard for backend, PostgreSQL, Redis, suite status and evidence.
- `run-certification.js` — local certification runner with suite selection and evidence capture.
- `artifacts/` — generated disposable certification evidence.

## Start the observer

```bash
cd ~/vaayu/apps/backend
export VAAYU_TEST_TARGET=disposable
node certification/server.js
```

Control Center listens on `127.0.0.1:4100` by default.

## Run certification

The backend must already be running against the disposable PostgreSQL/Redis environment.

```bash
cd ~/vaayu/apps/backend
export VAAYU_TEST_TARGET=disposable
export VAAYU_TEST_BASE=http://127.0.0.1:4000
node certification/run-certification.js
```

Run a subset:

```bash
export CERTIFICATION_SUITES=portal-smoke,customer-journey,merchant-journey
node certification/run-certification.js
```

Available suites:

- portal-smoke
- customer-journey
- merchant-journey
- browser-all
- lifecycle
- merchant-e2e
- enterprise-operations
- websocket-e2e
- location-integrity
- postgres-ledger
- security

## Public access

For temporary remote observation only, expose **4100**, never 4000/55432/56379:

```bash
cloudflared tunnel --url http://127.0.0.1:4100
```

The public dashboard is intentionally observational. It does not provide a public endpoint for executing destructive certification suites.

## Evidence

The runner writes:

- `running.json` while a run is active.
- `<suite>.json` for each suite.
- `latest.json` for the latest aggregate.
- `cert-<timestamp>.json` for historical run summaries.

Playwright screenshots, traces and reports remain in the existing `test-results/` and `playwright-report/` directories and are recorded in aggregate evidence metadata.
