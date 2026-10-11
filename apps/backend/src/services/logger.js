/**
 * VAAYU Milestone 6 Phase 6.6: Structured Logging Abstraction (logger.js)
 * 
 * Features:
 * 1. Structured JSON output format for log aggregators (ELK, Datadog, CloudWatch).
 * 2. Levels: DEBUG, INFO, WARN, ERROR.
 * 3. Automatic PII, Secrets & Credentials Redaction (passwords, JWTs, OTPs, auth headers).
 * 4. Contextual fields (timestamp, level, service, event, nodeId, requestId, orderId, driverId, customerId).
 */

class Logger {
  constructor() {
    this.serviceName = 'vaayu-backend';
    this.nodeId = process.env.NODE_ID || 'node_main';
    this.logLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();

    this.LEVEL_WEIGHTS = {
      DEBUG: 10,
      INFO: 20,
      WARN: 30,
      ERROR: 40
    };

    // Sensitive field keys to redact from metadata/payloads
    this.SENSITIVE_KEYS = new Set([
      'password',
      'jwt',
      'token',
      'refreshtoken',
      'refresh_token',
      'authorization',
      'bearer',
      'otp',
      'deliveryotp',
      'pickupotp',
      'code',
      'secret',
      'apikey',
      'api_key',
      'creditcard',
      'cvv',
      'auth',
      'phone',
      'phonenumber',
      'mobile'
    ]);
  }

  shouldLog(level) {
    const targetWeight = this.LEVEL_WEIGHTS[level] || 20;
    const currentWeight = this.LEVEL_WEIGHTS[this.logLevel] || 20;
    return targetWeight >= currentWeight;
  }

  redactSensitiveData(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map(item => this.redactSensitiveData(item));
    }

    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (this.SENSITIVE_KEYS.has(lowerKey)) {
        cleaned[key] = '[REDACTED]';
      } else if (value && typeof value === 'object') {
        cleaned[key] = this.redactSensitiveData(value);
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  formatLog(level, eventName, message, meta = {}) {
    const requestId = meta.requestId || meta.xRequestId || null;
    const orderId = meta.orderId || meta.tripId || null;
    const driverId = meta.driverId || null;
    const customerId = meta.customerId || null;
    const service = meta.service || this.serviceName;

    const sanitizedMeta = this.redactSensitiveData(meta);

    // Remove extracted top-level identifiers from meta body to avoid duplication
    delete sanitizedMeta.requestId;
    delete sanitizedMeta.xRequestId;
    delete sanitizedMeta.orderId;
    delete sanitizedMeta.tripId;
    delete sanitizedMeta.driverId;
    delete sanitizedMeta.customerId;
    delete sanitizedMeta.service;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service,
      event: eventName,
      nodeId: this.nodeId,
      message,
      ...(requestId ? { requestId } : {}),
      ...(orderId ? { orderId } : {}),
      ...(driverId ? { driverId } : {}),
      ...(customerId ? { customerId } : {}),
      ...(Object.keys(sanitizedMeta).length > 0 ? { metadata: sanitizedMeta } : {})
    };

    return JSON.stringify(entry);
  }

  debug(eventName, message, meta = {}) {
    if (this.shouldLog('DEBUG')) {
      console.log(this.formatLog('DEBUG', eventName, message, meta));
    }
  }

  info(eventName, message, meta = {}) {
    if (this.shouldLog('INFO')) {
      console.log(this.formatLog('INFO', eventName, message, meta));
    }
  }

  warn(eventName, message, meta = {}) {
    if (this.shouldLog('WARN')) {
      console.warn(this.formatLog('WARN', eventName, message, meta));
    }
  }

  error(eventName, message, meta = {}) {
    if (this.shouldLog('ERROR')) {
      console.error(this.formatLog('ERROR', eventName, message, meta));
    }
  }
}

const logger = new Logger();
module.exports = { logger, Logger };
