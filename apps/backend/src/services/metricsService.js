/**
 * VAAYU Milestone 6 Phase 6.6: Metrics & Operational Telemetry Engine (metricsService.js)
 * 
 * Features:
 * 1. Counters for business, lifecycle, dispatch, telemetry, routing, Redis, PostgreSQL, security & WebSockets.
 * 2. Latency Histograms with p50, p95, p99 percentile calculation.
 * 3. Gauges for active WebSocket connections & PostgreSQL pool stats.
 * 4. Observability-only semantics: NEVER mutates business or state machine data.
 * 5. Snapshot JSON & Prometheus exposition format generation.
 */

class MetricsService {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.MAX_HISTOGRAM_SAMPLES = 1000;

    this.initializeDefaultMetrics();
  }

  initializeDefaultMetrics() {
    const defaultCounters = [
      // Orders & Lifecycle
      'orders_created_total',
      'orders_cancelled_total',
      'orders_completed_total',
      'orders_failed_total',
      'delivery_transition_total',
      'delivery_transition_failure_total',

      // Dispatch
      'dispatch_attempts_total',
      'dispatch_success_total',
      'dispatch_no_driver_total',
      'dispatch_driver_lock_collision_total',
      'dispatch_offer_created_total',
      'dispatch_offer_accepted_total',
      'dispatch_offer_declined_total',
      'dispatch_offer_timeout_total',

      // Driver Telemetry
      'driver_location_updates_total',
      'driver_location_rejected_total',
      'driver_online_total',
      'driver_offline_total',

      // Routing
      'routing_requests_total',
      'routing_provider_success_total',
      'routing_provider_failure_total',
      'routing_fallback_total',
      'routing_circuit_breaker_tripped_total',
      'routing_anomalies_detected_total',
      'routing_cache_hits_total',
      'routing_cache_misses_total',
      'eta_calculations_total',

      // Notifications (Pillar 12)
      'notifications_dispatched_total',
      'notifications_delivered_total',
      'notifications_failed_total',
      'notifications_deduped_total',
      'notifications_stale_suppressed_total',
      'notifications_dlq_total',
      'notifications_circuit_breaker_tripped_total',

      // Fraud & Risk (Pillar 13)
      'risk_evaluations_total',
      'risk_decisions_allow_total',
      'risk_decisions_review_total',
      'risk_decisions_delay_total',
      'risk_decisions_block_total',
      'risk_gps_spoofing_detected_total',
      'risk_velocity_violations_total',
      'risk_collusion_detected_total',
      'risk_maker_checker_actions_total',

      // Enterprise & Multi-Tenancy (Pillar 14)
      'tenant_isolation_checks_total',
      'tenant_cross_access_blocked_total',
      'tenant_quota_exceeded_total',
      'tenant_bulk_operations_total',
      'tenant_suspended_rejections_total',

      // Redis
      'redis_command_errors_total',
      'redis_connection_errors_total',
      'redis_reconnect_total',
      'redis_lock_acquire_success_total',
      'redis_lock_acquire_failure_total',
      'redis_lock_release_total',
      'redis_pubsub_publish_total',
      'redis_pubsub_failure_total',
      'redis_pubsub_reconnect_total',

      // PostgreSQL
      'postgres_queries_total',
      'postgres_query_errors_total',
      'postgres_transaction_failures_total',
      'postgres_concurrency_conflict_total',

      // Security & Auth
      'auth_success_total',
      'auth_failure_total',
      'authorization_denied_total',
      'bola_denied_total',
      'rate_limit_rejected_total',
      'idempotency_replay_total',
      'invalid_token_total',
      'expired_token_total',
      'websocket_authorization_denied_total',

      // WebSockets
      'websocket_connections_total',
      'websocket_disconnects_total',
      'websocket_messages_sent_total',
      'websocket_events_published_total',
      'websocket_pubsub_failures_total',
      'websocket_room_join_denied_total',
      'cross_node_event_delivery_total'
    ];

    defaultCounters.forEach(name => this.counters.set(name, 0));

    const defaultGauges = [
      'websocket_connections_active',
      'postgres_connection_pool_active',
      'postgres_connection_pool_idle',
      'postgres_connection_pool_waiting'
    ];

    defaultGauges.forEach(name => this.gauges.set(name, 0));

    const defaultLatencies = [
      'location_search_latency',
      'routing_latency',
      'dispatch_latency',
      'driver_telemetry_latency',
      'postgres_query_latency',
      'redis_operation_latency',
      'websocket_publish_latency',
      'redis_lock_latency'
    ];

    defaultLatencies.forEach(name => this.histograms.set(name, []));
  }

  increment(metricName, value = 1) {
    const current = this.counters.get(metricName) || 0;
    this.counters.set(metricName, current + value);
  }

  setGauge(metricName, value) {
    this.gauges.set(metricName, value);
  }

  recordLatency(metricName, durationMs) {
    if (!this.histograms.has(metricName)) {
      this.histograms.set(metricName, []);
    }
    const samples = this.histograms.get(metricName);
    samples.push(parseFloat(durationMs) || 0);

    if (samples.length > this.MAX_HISTOGRAM_SAMPLES) {
      samples.shift();
    }
  }

  getPercentiles(samples) {
    if (!samples || samples.length === 0) {
      return { count: 0, p50: 0, p95: 0, p99: 0, avg: 0 };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, val) => acc + val, 0);

    const getP = (pct) => {
      const index = Math.min(count - 1, Math.floor(count * pct));
      return Math.round(sorted[index] * 100) / 100;
    };

    return {
      count,
      avg: Math.round((sum / count) * 100) / 100,
      p50: getP(0.50),
      p95: getP(0.95),
      p99: getP(0.99)
    };
  }

  getSnapshot() {
    const snapshotCounters = {};
    for (const [key, val] of this.counters.entries()) {
      snapshotCounters[key] = val;
    }

    const snapshotGauges = {};
    for (const [key, val] of this.gauges.entries()) {
      snapshotGauges[key] = val;
    }

    const snapshotLatencies = {};
    for (const [key, samples] of this.histograms.entries()) {
      snapshotLatencies[key] = this.getPercentiles(samples);
    }

    return {
      timestamp: new Date().toISOString(),
      nodeId: process.env.NODE_ID || 'node_main',
      counters: snapshotCounters,
      gauges: snapshotGauges,
      latencies: snapshotLatencies
    };
  }

  getPrometheusFormat() {
    let lines = [];
    lines.push('# HELP vaayu_metrics Operational Telemetry Metrics');
    lines.push('# TYPE vaayu_metrics gauge');

    for (const [key, val] of this.counters.entries()) {
      lines.push(`vaayu_${key} ${val}`);
    }

    for (const [key, val] of this.gauges.entries()) {
      lines.push(`vaayu_${key} ${val}`);
    }

    for (const [key, samples] of this.histograms.entries()) {
      const stats = this.getPercentiles(samples);
      lines.push(`vaayu_${key}_count ${stats.count}`);
      lines.push(`vaayu_${key}_p50 ${stats.p50}`);
      lines.push(`vaayu_${key}_p95 ${stats.p95}`);
      lines.push(`vaayu_${key}_p99 ${stats.p99}`);
    }

    return lines.join('\n');
  }

  static get DEFAULT_SLO_BUDGETS() {
    return {
      dispatch_latency: { p95: 250, p99: 500, unit: 'ms', description: 'Order dispatch and driver matching' },
      driver_telemetry_latency: { p95: 20, p99: 50, unit: 'ms', description: 'Driver location update ingestion' },
      postgres_query_latency: { p95: 50, p99: 100, unit: 'ms', description: 'Database double-entry & order transactions' },
      routing_latency: { p95: 50, p99: 150, unit: 'ms', description: 'Routing engine and distance calculation' },
      location_search_latency: { p95: 50, p99: 150, unit: 'ms', description: 'Geocoding and place searches' },
      redis_operation_latency: { p95: 10, p99: 25, unit: 'ms', description: 'Redis lock and cache operations' },
      websocket_publish_latency: { p95: 20, p99: 50, unit: 'ms', description: 'Real-time WebSocket event dispatch' }
    };
  }

  evaluateSlo(metricName, customBudget = null) {
    const budget = customBudget || MetricsService.DEFAULT_SLO_BUDGETS[metricName];
    if (!budget) {
      return {
        metricName,
        status: 'UNCONFIGURED',
        compliant: false,
        reason: `No SLO budget defined for ${metricName}`
      };
    }

    const samples = this.histograms.get(metricName) || [];
    const stats = this.getPercentiles(samples);

    if (stats.count === 0) {
      return {
        metricName,
        status: 'NO_DATA',
        compliant: true,
        budget,
        observed: stats
      };
    }

    const p95Compliant = stats.p95 <= budget.p95;
    const p99Compliant = stats.p99 <= budget.p99;
    const overallCompliant = p95Compliant && p99Compliant;

    const p95ConsumedPct = Math.round((stats.p95 / budget.p95) * 10000) / 100;
    const p99ConsumedPct = Math.round((stats.p99 / budget.p99) * 10000) / 100;

    return {
      metricName,
      status: overallCompliant ? 'COMPLIANT' : 'BREACHED',
      compliant: overallCompliant,
      p95Compliant,
      p99Compliant,
      budget,
      observed: stats,
      budgetConsumption: {
        p95ConsumedPct,
        p99ConsumedPct,
        maxConsumedPct: Math.max(p95ConsumedPct, p99ConsumedPct)
      }
    };
  }

  evaluateAllSlos(customBudgets = {}) {
    const budgets = { ...MetricsService.DEFAULT_SLO_BUDGETS, ...customBudgets };
    const evaluations = {};
    let allCompliant = true;

    for (const [metricName, budget] of Object.entries(budgets)) {
      const result = this.evaluateSlo(metricName, budget);
      evaluations[metricName] = result;
      if (!result.compliant) {
        allCompliant = false;
      }
    }

    return {
      timestamp: new Date().toISOString(),
      allCompliant,
      slos: evaluations
    };
  }

  evaluateAlertRules() {
    const alerts = [];
    const now = new Date().toISOString();

    // 1. Circuit Breaker Trips
    const routingBreakerTrips = this.counters.get('routing_circuit_breaker_tripped_total') || 0;
    if (routingBreakerTrips > 0) {
      alerts.push({
        alertId: 'ROUTING_CIRCUIT_BREAKER_OPEN',
        severity: 'CRITICAL',
        metric: 'routing_circuit_breaker_tripped_total',
        value: routingBreakerTrips,
        message: 'Routing circuit breaker tripped; upstream map service degraded.',
        timestamp: now
      });
    }

    const notifBreakerTrips = this.counters.get('notifications_circuit_breaker_tripped_total') || 0;
    if (notifBreakerTrips > 0) {
      alerts.push({
        alertId: 'NOTIFICATIONS_CIRCUIT_BREAKER_OPEN',
        severity: 'WARNING',
        metric: 'notifications_circuit_breaker_tripped_total',
        value: notifBreakerTrips,
        message: 'Notification provider circuit breaker tripped; falling back or queuing.',
        timestamp: now
      });
    }

    // 2. High Error Rate Alert (> 5% delivery transition failures)
    const totalTransitions = this.counters.get('delivery_transition_total') || 0;
    const failedTransitions = this.counters.get('delivery_transition_failure_total') || 0;
    if (totalTransitions >= 20 && (failedTransitions / totalTransitions) > 0.05) {
      alerts.push({
        alertId: 'HIGH_DELIVERY_TRANSITION_FAILURE_RATE',
        severity: 'CRITICAL',
        metric: 'delivery_transition_failure_rate',
        value: Math.round((failedTransitions / totalTransitions) * 10000) / 100,
        message: `High delivery state transition failure rate: ${Math.round((failedTransitions / totalTransitions) * 100)}%`,
        timestamp: now
      });
    }

    // 3. Security Breach / BOLA Surge Alert
    const bolaDenied = this.counters.get('bola_denied_total') || 0;
    if (bolaDenied >= 10) {
      alerts.push({
        alertId: 'BOLA_ATTACK_SURGE',
        severity: 'CRITICAL',
        metric: 'bola_denied_total',
        value: bolaDenied,
        message: `Broken Object Level Authorization (BOLA) attempts exceeded threshold: ${bolaDenied} events.`,
        timestamp: now
      });
    }

    // 4. Rate Limit Surge
    const rateLimitHits = this.counters.get('rate_limit_rejected_total') || 0;
    if (rateLimitHits >= 50) {
      alerts.push({
        alertId: 'RATE_LIMIT_ABUSE_SPIKE',
        severity: 'WARNING',
        metric: 'rate_limit_rejected_total',
        value: rateLimitHits,
        message: `API rate limit rejections exceeded threshold: ${rateLimitHits} rejected requests.`,
        timestamp: now
      });
    }

    // 5. Postgres Connection Starvation
    const poolWaiting = this.gauges.get('postgres_connection_pool_waiting') || 0;
    if (poolWaiting > 0) {
      alerts.push({
        alertId: 'POSTGRES_POOL_STARVATION',
        severity: 'CRITICAL',
        metric: 'postgres_connection_pool_waiting',
        value: poolWaiting,
        message: `PostgreSQL connection pool saturated; ${poolWaiting} queries waiting for client.`,
        timestamp: now
      });
    }

    // 6. SLO Latency Budget Violations
    const sloSummary = this.evaluateAllSlos();
    for (const [metric, res] of Object.entries(sloSummary.slos)) {
      if (res.status === 'BREACHED') {
        alerts.push({
          alertId: `SLO_BREACH_${metric.toUpperCase()}`,
          severity: 'WARNING',
          metric,
          value: res.observed.p99,
          threshold: res.budget.p99,
          message: `SLO breach on ${metric}: p99 observed ${res.observed.p99}ms exceeds budget ${res.budget.p99}ms.`,
          timestamp: now
        });
      }
    }

    return {
      activeAlertsCount: alerts.length,
      hasCriticalAlerts: alerts.some(a => a.severity === 'CRITICAL'),
      alerts
    };
  }

  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.initializeDefaultMetrics();
  }
}

const metricsService = new MetricsService();
module.exports = { metricsService, MetricsService };
