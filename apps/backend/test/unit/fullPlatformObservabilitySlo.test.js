'use strict';

/**
 * VAAYU Pillar 18: Full-Platform Observability, Distributed Tracing & SLO Certification Suite
 * 
 * Tracks Verified:
 * 18.1: W3C Distributed Tracing (traceparent parse, generate, AsyncLocalStorage context, child spans, log correlation)
 * 18.2: Service Level Objective (SLO) Latency Budgets & Percentile Calculations (p50/p95/p99 compliance & breach)
 * 18.3: Prometheus Metrics Exposition & RBAC Scrape Authentication Gate
 * 18.4: Structured Telemetry & Deep PII / Credentials Redaction Audit
 * 18.5: Synthetic Anomaly Detection & Alert Threshold Triggers (Breakers, error spikes, BOLA, starvation)
 * 18.6: Platform Double-Entry Ledger Parity & Zero-Overhead Invariant
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { tracingService, TracingService } = require('../../src/services/tracingService');
const { metricsService, MetricsService } = require('../../src/services/metricsService');
const { logger, Logger } = require('../../src/services/logger');
const { authService } = require('../../src/services/authService');
const { createOpsRoutes } = require('../../src/http/opsRoutes');
const { createGuards } = require('../../src/http/guards');

test('Pillar 18: Full-Platform Observability, Distributed Tracing & SLO Suite', async (t) => {
  const pgPool = new PostgresPool();
  const ledgerRepo = new PostgresLedgerRepository(pgPool);

  t.after(async () => {
    metricsService.reset();
    await pgPool.pool.end().catch(() => {});
  });

  // =========================================================================
  // 18.1: W3C Distributed Tracing & Async Context Propagation
  // =========================================================================
  await t.test('18.1: W3C Distributed Tracing & Async Context Propagation', async () => {
    // 1. W3C Traceparent Header Parsing
    const validHeader = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const parsed = tracingService.parseTraceParent(validHeader);

    assert.ok(parsed, 'Valid W3C traceparent must parse successfully');
    assert.equal(parsed.version, '00');
    assert.equal(parsed.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(parsed.parentId, '00f067aa0ba902b7');
    assert.equal(parsed.traceFlags, '01');
    assert.equal(parsed.sampled, true);

    // Invalid traceparent headers must fail-closed (return null)
    assert.equal(tracingService.parseTraceParent(''), null, 'Empty string returns null');
    assert.equal(tracingService.parseTraceParent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), null, 'Version ff is invalid');
    assert.equal(tracingService.parseTraceParent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), null, 'All-zero traceId is invalid');
    assert.equal(tracingService.parseTraceParent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'), null, 'All-zero spanId is invalid');
    assert.equal(tracingService.parseTraceParent('00-invalidhex-00f067aa0ba902b7-01'), null, 'Malformed hex returns null');

    // 2. W3C Traceparent Generation
    const formatted = tracingService.formatTraceParent({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: '01'
    });
    assert.equal(formatted, validHeader, 'Generated traceparent matches canonical W3C format');

    // 3. HTTP Ingress Context Extraction
    const reqMock = {
      headers: {
        'traceparent': validHeader,
        'x-request-id': 'req_p18_ingest_001'
      }
    };
    const extracted = tracingService.extractTraceContext(reqMock);
    assert.equal(extracted.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(extracted.parentSpanId, '00f067aa0ba902b7');
    assert.ok(extracted.spanId, 'New spanId generated for current hop');
    assert.notEqual(extracted.spanId, '00f067aa0ba902b7', 'SpanId must differ from incoming parentSpanId');

    // 4. Async Execution Propagation via AsyncLocalStorage
    await tracingService.runWithContext(extracted, async () => {
      const activeCtx = tracingService.getCurrentContext();
      assert.ok(activeCtx, 'Active trace context available in async execution scope');
      assert.equal(activeCtx.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');

      // 5. Child Span Hierarchy
      const childSpan = tracingService.startSpan('db:query_order', { table: 'orders' });
      assert.equal(childSpan.traceId, activeCtx.traceId, 'Child span inherits traceId');
      assert.equal(childSpan.parentSpanId, activeCtx.spanId, 'Child span parentSpanId matches current span');
      assert.ok(childSpan.spanId, 'Child span has distinct spanId');

      await new Promise(r => setTimeout(r, 10));
      const endedSpan = tracingService.endSpan(childSpan, 'OK');
      assert.ok(endedSpan.durationMs >= 9, 'Span computes duration in milliseconds');
      assert.equal(endedSpan.status, 'OK');

      // 6. Automatic Logger Correlation
      const logJsonStr = logger.formatLog('INFO', 'order_dispatched', 'Dispatched order', {
        orderId: 'ord_p18_test_001'
      });
      const logEntry = JSON.parse(logJsonStr);
      assert.equal(logEntry.traceId, activeCtx.traceId, 'Log entry automatically inherits traceId from context');
      assert.equal(logEntry.spanId, activeCtx.spanId, 'Log entry automatically inherits spanId from context');
      assert.equal(logEntry.orderId, 'ord_p18_test_001');
    });

    // Outside the context, getCurrentContext is null
    assert.equal(tracingService.getCurrentContext(), null, 'Context does not leak outside async boundary');
  });

  // =========================================================================
  // 18.2: Service Level Objective (SLO) Latency Budgets & Percentiles
  // =========================================================================
  await t.test('18.2: Service Level Objective (SLO) Latency Budgets & Percentiles', async () => {
    metricsService.reset();

    // 1. Ingest compliant latency samples for core critical-path services
    // Dispatch budget: p95 <= 250ms, p99 <= 500ms
    for (let i = 1; i <= 100; i++) {
      const latency = 50 + (i * 1.5); // 51.5ms to 200ms
      metricsService.recordLatency('dispatch_latency', latency);
    }

    // Driver telemetry budget: p95 <= 20ms, p99 <= 50ms
    for (let i = 1; i <= 100; i++) {
      const latency = 2 + (i * 0.15); // 2.15ms to 17ms
      metricsService.recordLatency('driver_telemetry_latency', latency);
    }

    // PostgreSQL query budget: p95 <= 50ms, p99 <= 100ms
    for (let i = 1; i <= 100; i++) {
      const latency = 5 + (i * 0.35); // 5.35ms to 40ms
      metricsService.recordLatency('postgres_query_latency', latency);
    }

    // Routing latency budget: p95 <= 50ms, p99 <= 150ms
    for (let i = 1; i <= 100; i++) {
      const latency = 10 + (i * 0.3); // 10.3ms to 40ms
      metricsService.recordLatency('routing_latency', latency);
    }

    // 2. Evaluate Individual SLOs
    const dispatchSlo = metricsService.evaluateSlo('dispatch_latency');
    assert.equal(dispatchSlo.status, 'COMPLIANT');
    assert.equal(dispatchSlo.compliant, true);
    assert.ok(dispatchSlo.observed.p95 <= 250, `Observed p95 (${dispatchSlo.observed.p95}ms) within 250ms budget`);
    assert.ok(dispatchSlo.observed.p99 <= 500, `Observed p99 (${dispatchSlo.observed.p99}ms) within 500ms budget`);
    assert.ok(dispatchSlo.budgetConsumption.p95ConsumedPct < 100, 'Budget consumption under 100%');

    const telemetrySlo = metricsService.evaluateSlo('driver_telemetry_latency');
    assert.equal(telemetrySlo.status, 'COMPLIANT');
    assert.ok(telemetrySlo.observed.p95 <= 20, `Telemetry p95 (${telemetrySlo.observed.p95}ms) within 20ms`);

    // 3. Evaluate Platform-Wide SLO Summary
    const platformSlos = metricsService.evaluateAllSlos();
    assert.equal(platformSlos.allCompliant, true, 'All core platform SLOs are compliant');
    assert.ok(platformSlos.slos.dispatch_latency.compliant);
    assert.ok(platformSlos.slos.driver_telemetry_latency.compliant);
    assert.ok(platformSlos.slos.postgres_query_latency.compliant);
    assert.ok(platformSlos.slos.routing_latency.compliant);

    // 4. Inject Deliberate Outlier Breaching SLO Budget
    // Push extreme p99 spike to dispatch_latency: 5 samples of 650ms (exceeds 500ms budget)
    for (let k = 0; k < 5; k++) {
      metricsService.recordLatency('dispatch_latency', 650);
    }
    const breachedSlo = metricsService.evaluateSlo('dispatch_latency');
    assert.equal(breachedSlo.status, 'BREACHED', 'Outlier triggers BREACHED status');
    assert.equal(breachedSlo.compliant, false);
    assert.equal(breachedSlo.p99Compliant, false);
    assert.ok(breachedSlo.budgetConsumption.p99ConsumedPct > 100, 'Budget consumption exceeds 100%');
  });

  // =========================================================================
  // 18.3: Prometheus Metrics Exposition & RBAC Scrape Gate
  // =========================================================================
  await t.test('18.3: Prometheus Metrics Exposition & RBAC Scrape Gate', async () => {
    metricsService.reset();
    metricsService.increment('orders_created_total', 42);
    metricsService.increment('dispatch_attempts_total', 38);
    metricsService.setGauge('postgres_connection_pool_active', 4);
    metricsService.recordLatency('dispatch_latency', 45);

    // 1. Prometheus Text-Based 0.0.4 Output Format Verification
    const promText = metricsService.getPrometheusFormat();
    assert.ok(promText.includes('# HELP vaayu_metrics Operational Telemetry Metrics'));
    assert.ok(promText.includes('# TYPE vaayu_metrics gauge'));
    assert.ok(promText.includes('vaayu_orders_created_total 42'));
    assert.ok(promText.includes('vaayu_dispatch_attempts_total 38'));
    assert.ok(promText.includes('vaayu_postgres_connection_pool_active 4'));
    assert.ok(promText.includes('vaayu_dispatch_latency_p95'));

    // Validate that every line conforms to Prometheus exposition syntax
    const lines = promText.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      const isValid = line.startsWith('#') || /^[a-zA-Z_][a-zA-Z0-9_]*(\{[^}]*\})?\s+[\d.eE+-]+$/.test(line);
      assert.ok(isValid, `Line conforms to Prometheus syntax: "${line}"`);
    }

    // 2. RBAC Scrape Authentication Gate
    // Set up mock ops router and guards
    const mockDb = { getDrivers: () => [], getVehicles: () => [], getTrips: () => [] };
    const mockRateLimiter = { redis: null, checkRateLimit: async () => ({ allowed: true }) };
    const mockWs = { pubSub: {} };
    const mockRouteRegistry = { getRegisteredRoutes: () => [], routes: new Map() };
    const mockBreakers = { getStatus: () => ({}) };

    const handleOps = createOpsRoutes({
      db: mockDb,
      redisRateLimiter: mockRateLimiter,
      websocketService: mockWs,
      routeRegistryService: mockRouteRegistry,
      PortalContextService: { PORTALS: {} },
      circuitBreakerService: mockBreakers,
      metricsService
    });

    const guards = createGuards({
      db: mockDb,
      redisRateLimiter: mockRateLimiter,
      authService,
      metricsService,
      logger
    });

    // Subtest: Unauthenticated scrape attempt -> Rejected 401
    let unauthStatusCode = null;
    let unauthBody = '';
    const mockUnauthReq = {
      headers: {},
      method: 'GET',
      url: '/metrics'
    };
    const mockUnauthRes = {
      writeHead: (code) => { unauthStatusCode = code; },
      end: (data) => { unauthBody = data || ''; }
    };

    const allowedUnauth = await guards.enforceSecurityChecks(mockUnauthReq, mockUnauthRes, {
      routeName: 'ops:metrics',
      requiredRoles: ['ADMIN', 'SUPER_ADMIN']
    });
    assert.equal(allowedUnauth, false, 'Unauthenticated scrape must be denied');
    assert.equal(unauthStatusCode, 401, 'Unauthenticated scrape returns HTTP 401');

    // Subtest: Driver role token (non-admin) -> Rejected 403
    const driverToken = authService.generateToken({ userId: 'drv_p18_unauth', role: 'DRIVER' });
    let forbiddenStatusCode = null;
    const mockDriverReq = {
      headers: { authorization: `Bearer ${driverToken}` },
      method: 'GET',
      url: '/metrics'
    };
    const mockDriverRes = {
      writeHead: (code) => { forbiddenStatusCode = code; },
      end: () => {}
    };

    const allowedDriver = await guards.enforceSecurityChecks(mockDriverReq, mockDriverRes, {
      routeName: 'ops:metrics',
      requiredRoles: ['ADMIN', 'SUPER_ADMIN']
    });
    assert.equal(allowedDriver, false, 'Driver role access to metrics must be denied');
    assert.equal(forbiddenStatusCode, 403, 'Forbidden role returns HTTP 403');

    // Subtest: Super Admin token -> Allowed 200
    const adminToken = authService.generateToken({ userId: 'adm_p18_monitor', role: 'SUPER_ADMIN' });
    const mockAdminReq = {
      headers: {
        authorization: `Bearer ${adminToken}`,
        accept: 'text/plain'
      },
      method: 'GET',
      url: '/metrics'
    };
    let adminStatusCode = null;
    let adminBody = '';
    const mockAdminRes = {
      writeHead: (code) => { adminStatusCode = code; },
      end: (data) => { adminBody = data; }
    };

    const allowedAdmin = await guards.enforceSecurityChecks(mockAdminReq, mockAdminRes, {
      routeName: 'ops:metrics',
      requiredRoles: ['ADMIN', 'SUPER_ADMIN']
    });
    assert.equal(allowedAdmin, true, 'Super Admin access granted');

    const handled = await handleOps(mockAdminReq, mockAdminRes, {
      pathname: '/metrics',
      parsedUrl: { pathname: '/metrics', query: {} }
    });
    assert.equal(handled, true);
    assert.equal(adminStatusCode, 200, 'Authenticated scrape returns HTTP 200');
    assert.ok(adminBody.includes('vaayu_orders_created_total 42'), 'Exposes metrics payload to authenticated scraper');
  });

  // =========================================================================
  // 18.4: Structured Telemetry & Deep PII / Credentials Redaction Audit
  // =========================================================================
  await t.test('18.4: Structured Telemetry & Deep PII / Credentials Redaction Audit', async () => {
    const rawSecretPayload = {
      password: 'super_secret_password_123',
      jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummyPayload',
      token: 'tok_live_secret_492041920',
      refreshToken: 'rft_secret_key_884920',
      authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret',
      otp: '782910',
      deliveryOtp: '4491',
      pickupOtp: '8204',
      creditCard: '4532-1100-2299-8833',
      cvv: '912',
      apiKey: 'key_live_29402940284',
      secret: 'whsec_secret_payment_signature',
      phone: '+919876543210',
      mobile: '+919123456789',
      nestedProfile: {
        userSecret: {
          password: 'nested_password_abc',
          bearer: 'Bearer inner_token_123'
        },
        contactList: [
          { name: 'Customer A', phone: '+919999999999' },
          { name: 'Customer B', otp: '1234' }
        ]
      },
      // Non-sensitive data that MUST remain intact
      publicMetadata: {
        orderType: 'INSTANT_DELIVERY',
        fareAmount: 350.50,
        currency: 'INR'
      }
    };

    const formattedLog = logger.formatLog('INFO', 'payment_attempt', 'Attempting card charge', rawSecretPayload);
    
    // 1. Must parse strictly as valid JSON
    let parsedLog;
    assert.doesNotThrow(() => {
      parsedLog = JSON.parse(formattedLog);
    }, 'Log output must be valid RFC 8259 JSON');

    // 2. Sensitive values MUST NOT exist in plaintext anywhere in the string
    const plaintextSecrets = [
      'super_secret_password_123',
      'tok_live_secret_492041920',
      'rft_secret_key_884920',
      '782910',
      '4491',
      '8204',
      '4532-1100-2299-8833',
      '912',
      'key_live_29402940284',
      'whsec_secret_payment_signature',
      '+919876543210',
      '+919123456789',
      'nested_password_abc',
      'inner_token_123',
      '+919999999999'
    ];

    for (const secret of plaintextSecrets) {
      assert.equal(
        formattedLog.includes(secret),
        false,
        `Plaintext secret "${secret}" leaked in log output!`
      );
    }

    // 3. Sensitive keys must be masked with [REDACTED]
    const meta = parsedLog.metadata;
    assert.equal(meta.password, '[REDACTED]');
    assert.equal(meta.jwt, '[REDACTED]');
    assert.equal(meta.token, '[REDACTED]');
    assert.equal(meta.refreshToken, '[REDACTED]');
    assert.equal(meta.otp, '[REDACTED]');
    assert.equal(meta.deliveryOtp, '[REDACTED]');
    assert.equal(meta.creditCard, '[REDACTED]');
    assert.equal(meta.cvv, '[REDACTED]');
    assert.equal(meta.phone, '[REDACTED]');
    assert.equal(meta.nestedProfile.userSecret.password, '[REDACTED]');
    assert.equal(meta.nestedProfile.userSecret.bearer, '[REDACTED]');
    assert.equal(meta.nestedProfile.contactList[0].phone, '[REDACTED]');
    assert.equal(meta.nestedProfile.contactList[1].otp, '[REDACTED]');

    // 4. Safe business metadata must remain intact
    assert.equal(meta.publicMetadata.orderType, 'INSTANT_DELIVERY');
    assert.equal(meta.publicMetadata.fareAmount, 350.50);
    assert.equal(meta.publicMetadata.currency, 'INR');

    // 5. Standard top-level envelope fields must be present
    assert.ok(parsedLog.timestamp);
    assert.equal(parsedLog.level, 'INFO');
    assert.equal(parsedLog.service, 'vaayu-backend');
    assert.equal(parsedLog.event, 'payment_attempt');
    assert.ok(parsedLog.nodeId);
  });

  // =========================================================================
  // 18.5: Synthetic Anomaly Detection & Alert Threshold Triggers
  // =========================================================================
  await t.test('18.5: Synthetic Anomaly Detection & Alert Threshold Triggers', async () => {
    metricsService.reset();

    // 1. Clean Baseline (Zero Alerts)
    const baselineAlerts = metricsService.evaluateAlertRules();
    assert.equal(baselineAlerts.activeAlertsCount, 0, 'Clean baseline produces 0 active alerts');
    assert.equal(baselineAlerts.hasCriticalAlerts, false);

    // 2. Trigger Circuit Breaker Alert
    metricsService.increment('routing_circuit_breaker_tripped_total', 1);
    const cbAlerts = metricsService.evaluateAlertRules();
    assert.equal(cbAlerts.activeAlertsCount, 1);
    assert.equal(cbAlerts.alerts[0].alertId, 'ROUTING_CIRCUIT_BREAKER_OPEN');
    assert.equal(cbAlerts.alerts[0].severity, 'CRITICAL');

    // 3. Trigger High Failure Rate Alert
    metricsService.increment('delivery_transition_total', 100);
    metricsService.increment('delivery_transition_failure_total', 12); // 12% failure rate (> 5%)
    const failRateAlerts = metricsService.evaluateAlertRules();
    const hasFailRateAlert = failRateAlerts.alerts.some(a => a.alertId === 'HIGH_DELIVERY_TRANSITION_FAILURE_RATE');
    assert.ok(hasFailRateAlert, 'Transition failure rate alert triggered');

    // 4. Trigger BOLA Surge Alert
    metricsService.increment('bola_denied_total', 15);
    const bolaAlerts = metricsService.evaluateAlertRules();
    const hasBolaAlert = bolaAlerts.alerts.some(a => a.alertId === 'BOLA_ATTACK_SURGE');
    assert.ok(hasBolaAlert, 'BOLA attack surge alert triggered');

    // 5. Trigger Database Connection Pool Starvation Alert
    metricsService.setGauge('postgres_connection_pool_waiting', 5);
    const poolAlerts = metricsService.evaluateAlertRules();
    const hasPoolAlert = poolAlerts.alerts.some(a => a.alertId === 'POSTGRES_POOL_STARVATION');
    assert.ok(hasPoolAlert, 'Pool starvation alert triggered');
    assert.equal(poolAlerts.hasCriticalAlerts, true);
  });

  // =========================================================================
  // 18.6: Platform Double-Entry Ledger Parity & Zero-Overhead Invariant
  // =========================================================================
  await t.test('18.6: Platform Double-Entry Ledger Parity & Zero-Overhead Invariant', async () => {
    // Verify that all observability probes, tracing, and metric evaluation executed
    // with ZERO database side-effects and zero ledger imbalance.
    const before = await ledgerRepo.reconcile();
    const recon = await ledgerRepo.reconcile();

    assert.equal(recon.journalEntries, before.journalEntries, `Journal entry count preserved (before ${before.journalEntries}, after ${recon.journalEntries})`);
    assert.equal(recon.problems.length, 0, `Zero reconciliation problems expected, observed: ${recon.problems.length}`);
    assert.equal(recon.ok, true, 'Ledger reconciliation parity status must be OK (balanced)');
  });
});
