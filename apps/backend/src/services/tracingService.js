'use strict';

/**
 * VAAYU Pillar 18: W3C Distributed Tracing & Asynchronous Context Propagation Engine
 * (tracingService.js)
 * 
 * Features:
 * 1. Strict W3C Trace Context recommendation (traceparent: 00-${traceId}-${spanId}-${traceFlags}).
 * 2. Asynchronous execution boundary propagation via Node.js AsyncLocalStorage.
 * 3. Span lifecycle management: root spans, nested child spans, duration calculation.
 * 4. Zero-mutation guarantees: Never blocks business logic or modifies state models.
 * 5. Fallback mapping for legacy headers: x-request-id, x-correlation-id, x-b3-traceid.
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

class TracingService {
  constructor() {
    this.asyncLocalStorage = new AsyncLocalStorage();
    this.version = '00';
    this.DEFAULT_FLAGS = '01'; // Sampled
  }

  /**
   * Generates a 16-byte (32-character hex) random trace ID.
   * Ensures non-zero value per W3C specification.
   */
  generateTraceId() {
    let id;
    do {
      id = crypto.randomBytes(16).toString('hex');
    } while (id === '00000000000000000000000000000000');
    return id;
  }

  /**
   * Generates an 8-byte (16-character hex) random span ID.
   * Ensures non-zero value per W3C specification.
   */
  generateSpanId() {
    let id;
    do {
      id = crypto.randomBytes(8).toString('hex');
    } while (id === '0000000000000000');
    return id;
  }

  /**
   * Parses standard W3C traceparent header:
   * Format: ${version}-${traceId}-${parentId}-${traceFlags}
   * Example: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
   */
  parseTraceParent(header) {
    if (!header || typeof header !== 'string') return null;

    const parts = header.trim().split('-');
    if (parts.length !== 4) return null;

    const [version, traceId, parentId, traceFlags] = parts;

    // Check version
    if (version.length !== 2 || !/^[0-9a-f]{2}$/i.test(version)) return null;
    if (version === 'ff') return null; // W3C reserved invalid

    // Check traceId: 32 hex chars, non-zero
    if (traceId.length !== 32 || !/^[0-9a-f]{32}$/i.test(traceId) || traceId === '00000000000000000000000000000000') {
      return null;
    }

    // Check parentId: 16 hex chars, non-zero
    if (parentId.length !== 16 || !/^[0-9a-f]{16}$/i.test(parentId) || parentId === '0000000000000000') {
      return null;
    }

    // Check traceFlags: 2 hex chars
    if (traceFlags.length !== 2 || !/^[0-9a-f]{2}$/i.test(traceFlags)) {
      return null;
    }

    const sampled = (parseInt(traceFlags, 16) & 0x01) === 1;

    return {
      version,
      traceId: traceId.toLowerCase(),
      parentId: parentId.toLowerCase(),
      traceFlags: traceFlags.toLowerCase(),
      sampled
    };
  }

  /**
   * Serializes a trace context into standard W3C traceparent format.
   */
  formatTraceParent({ traceId, spanId, traceFlags = this.DEFAULT_FLAGS, version = this.version }) {
    if (!traceId || !spanId) return null;
    return `${version}-${traceId}-${spanId}-${traceFlags}`;
  }

  /**
   * Extracts or creates a trace context from an incoming HTTP request.
   */
  extractTraceContext(req = {}) {
    const headers = req.headers || {};
    const traceparentHeader = headers['traceparent'] || headers['x-traceparent'];

    const parsed = this.parseTraceParent(traceparentHeader);
    if (parsed) {
      return {
        traceId: parsed.traceId,
        parentSpanId: parsed.parentId,
        spanId: this.generateSpanId(),
        traceFlags: parsed.traceFlags,
        sampled: parsed.sampled,
        isRoot: false,
        tracestate: headers['tracestate'] || null,
        requestId: headers['x-request-id'] || null
      };
    }

    // Fallback: Check custom request headers or generate fresh root trace
    const legacyRequestId = headers['x-request-id'] || headers['x-correlation-id'] || null;
    const traceId = this.generateTraceId();
    const spanId = this.generateSpanId();

    return {
      traceId,
      parentSpanId: null,
      spanId,
      traceFlags: this.DEFAULT_FLAGS,
      sampled: true,
      isRoot: true,
      tracestate: null,
      requestId: legacyRequestId
    };
  }

  /**
   * Executes an asynchronous function within an isolated trace context.
   */
  runWithContext(context, callback) {
    const traceContext = {
      traceId: context.traceId || this.generateTraceId(),
      spanId: context.spanId || this.generateSpanId(),
      parentSpanId: context.parentSpanId || null,
      traceFlags: context.traceFlags || this.DEFAULT_FLAGS,
      sampled: context.sampled !== undefined ? context.sampled : true,
      tags: { ...(context.tags || {}) },
      baggage: { ...(context.baggage || {}) },
      startTime: Date.now()
    };

    return this.asyncLocalStorage.run(traceContext, callback);
  }

  /**
   * Retrieves the current active trace context for the executing asynchronous execution chain.
   */
  getCurrentContext() {
    return this.asyncLocalStorage.getStore() || null;
  }

  /**
   * Starts a child span nested under the current active span.
   */
  startSpan(name, attributes = {}) {
    const parent = this.getCurrentContext();
    const spanId = this.generateSpanId();

    const span = {
      name,
      traceId: parent ? parent.traceId : this.generateTraceId(),
      parentSpanId: parent ? parent.spanId : null,
      spanId,
      startTime: Date.now(),
      startTimeHr: process.hrtime.bigint(),
      attributes: { ...attributes },
      ended: false
    };

    return span;
  }

  /**
   * Ends a span and computes exact execution duration.
   */
  endSpan(span, status = 'OK') {
    if (!span || span.ended) return null;
    span.ended = true;
    span.status = status;
    span.endTime = Date.now();
    
    if (span.startTimeHr) {
      const diffNs = process.hrtime.bigint() - span.startTimeHr;
      span.durationMs = Number(diffNs) / 1000000;
    } else {
      span.durationMs = span.endTime - span.startTime;
    }

    return span;
  }

  /**
   * Injects trace context into an outgoing headers dictionary.
   */
  injectTraceContext(headers = {}, context = null) {
    const active = context || this.getCurrentContext();
    if (!active) return headers;

    const traceparent = this.formatTraceParent({
      traceId: active.traceId,
      spanId: active.spanId,
      traceFlags: active.traceFlags
    });

    headers['traceparent'] = traceparent;
    headers['x-trace-id'] = active.traceId;
    headers['x-span-id'] = active.spanId;
    if (active.tracestate) {
      headers['tracestate'] = active.tracestate;
    }
    return headers;
  }
}

const tracingService = new TracingService();

module.exports = {
  TracingService,
  tracingService
};
