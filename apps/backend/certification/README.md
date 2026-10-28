# VAAYU Certification Control Center

Temporary, read-only observability surface for the disposable certification environment.

## Safety boundary

This service refuses to start when `NODE_ENV=production` or `VAAYU_TEST_TARGET` is not `disposable`. Do not expose PostgreSQL or Redis directly. Only the certification HTTP service should be tunneled publicly.

## Start

From `apps/backend` with the disposable certification environment already exported:

```bash
node certification/server.js
```

The dashboard listens on `http://127.0.0.1:4100` by default.

## Public temporary access

Create a separate temporary tunnel to port 4100, for example:

```bash
cloudflared tunnel --url http://127.0.0.1:4100
```

The dashboard observes the backend at `VAAYU_TEST_BASE` and reads only the disposable PostgreSQL/Redis state.

## API

- `/` — certification dashboard
- `/api/system` — backend, PostgreSQL, Redis health snapshot
- `/api/database` — PostgreSQL collection counts and recent record metadata
- `/api/suites` — registered certification suite names
- `/api/runs` — in-memory run history for this observer process

## Browser evidence runner

The repository also contains `certification/run-certification.js`. It is intentionally separate from the public observer. It runs the current browser certification suites sequentially and writes JSON evidence into `certification/artifacts/`.

Run it only in the disposable certification environment:

```bash
node certification/run-certification.js
```

Set `PLAYWRIGHT_BASE_URL` to the public VAAYU URL when testing the public deployment; otherwise it defaults to `VAAYU_TEST_BASE`.
