# VAAYU Certification Control Center

Disposable-environment certification and observability layer for VAAYU.

## Safety boundary

This application refuses to start when `NODE_ENV=production` or `VAAYU_TEST_TARGET` is not exactly `disposable`. PostgreSQL and Redis are observed locally; they must never be exposed through the public tunnel.

## What this module verifies

The target is system correctness, not just page availability:

- customer, driver, merchant and admin browser surfaces
- parallel multi-role surface boot and backend reachability
- end-to-end customer and merchant journeys
- backend delivery lifecycle and operations
- WebSocket/realtime behaviour
- location and mobility integrity
- PostgreSQL persistence and ledger invariants
- security and authorization
- broader enterprise backend behavioural battery
- backend component inventory and syntax health
- evidence, historical runs and failure output

A component is never considered functional merely because its source file exists or passes syntax. Behavioural functionality must be proven by certification tests.

## Components

- `server.js` — read-only Control Center HTTP server.
- `public/index.html` — live dashboard for backend, PostgreSQL, Redis, component audit, enterprise battery, suite status and evidence.
- `run-certification.js` — local certification runner with suite selection and evidence capture.
- `component-audit.js` — backend source inventory, syntax and infrastructure audit.
- `enterprise-battery.js` — structured wrapper around the existing enterprise backend test battery.
- `../test/browser/multiRoleSurface.spec.js` — parallel customer/driver/merchant/admin browser-surface certification.
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
export CERTIFICATION_SUITES=portal-smoke,customer-journey,component-audit
node certification/run-certification.js
```

Available certification runner suites:

- portal-smoke
- customer-journey
- merchant-journey
- browser-all — includes the parallel multi-role browser test
- lifecycle
- merchant-e2e
- enterprise-operations
- websocket-e2e
- location-integrity
- postgres-ledger
- security
- component-audit
- enterprise-battery

The `enterprise-battery` executes the existing disposable-safe enterprise backend battery, which covers lifecycle, operations, realtime, PostgreSQL atomicity/routing, Redis locks, telemetry replay, dispatch concurrency, realtime resilience and disaster-recovery policy checks.

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
- `component-audit.json` for source/infrastructure audit evidence.
- `enterprise-battery.json` for the broader backend battery.
- `latest.json` for the latest aggregate.
- `cert-<timestamp>.json` for historical run summaries.

Playwright screenshots, traces and reports remain in the existing `test-results/` and `playwright-report/` directories and are recorded in aggregate evidence metadata.
