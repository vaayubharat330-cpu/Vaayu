# VAAYU Certification Environment

This environment is intentionally disposable. It has no persistent volumes and binds PostgreSQL/Redis only to loopback.

## Start

```bash
docker compose -f certification/docker-compose.yml up -d --wait
```

Use these local endpoints for destructive certification:

```text
PostgreSQL: postgresql://vaayu_cert:vaayu_cert@127.0.0.1:55432/vaayu_cert
Redis:      redis://127.0.0.1:56379
Backend:    http://127.0.0.1:4000
```

Before running the destructive aggregate backend runner, explicitly opt in:

```bash
export DATABASE_URL='postgresql://vaayu_cert:vaayu_cert@127.0.0.1:55432/vaayu_cert'
export REDIS_URL='redis://127.0.0.1:56379'
export VAAYU_TEST_BASE='http://127.0.0.1:4000'
export VAAYU_TEST_TARGET='disposable'
export VAAYU_ALLOW_DESTRUCTIVE_TESTS='true'
```

Then run the runner from `apps/backend`:

```bash
node scripts/run-all-tests.js
```

When finished, destroy all certification state:

```bash
docker compose -f certification/docker-compose.yml down -v --remove-orphans
```

The aggregate runner deliberately refuses non-loopback targets and requires the explicit disposable-target opt-in. This is a safety boundary, not a convenience flag.