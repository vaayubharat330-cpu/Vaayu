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
      'eta_calculations_total',

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

  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.initializeDefaultMetrics();
  }
}

const metricsService = new MetricsService();
module.exports = { metricsService, MetricsService };
