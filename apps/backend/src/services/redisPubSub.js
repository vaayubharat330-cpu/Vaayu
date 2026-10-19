const { RedisClient } = require('./redisClient');
const crypto = require('crypto');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

/**
 * VAAYU Milestone 6 Phase 6.4: Distributed Pub/Sub Event Bus Abstraction
 *
 * Features & Guarantees:
 * 1. Dedicated Subscriber Connection (separates subscriber client from command client).
 * 2. Standardized Internal Event Envelope (eventId, eventType, entityType, entityId, targetRoom, timestamp, sourceNode, payload).
 * 3. Anti-Loop & Non-Amplification Guard (sourceNode matching and local-only dispatch on message receipt).
 * 4. Resilient Redis Failure & Auto-Reconnect Recovery.
 * 5. Best-effort delivery property (does NOT block PostgreSQL durable transactions).
 * 6. Caller-supplied event IDs allow a local WebSocket delivery and its cross-node
 *    Redis delivery to represent the exact same logical event.
 */
class RedisPubSubManager {
  constructor(options = {}) {
    this.nodeId = options.nodeId || `node_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
    this.pubClient = options.pubClient || new RedisClient();
    this.subClient = options.subClient || new RedisClient();
    this.PRIMARY_CHANNEL = 'vaayu:ws:events';
    this.subscriptions = new Map();
    this.isConnected = false;
  }

  _unrefDisposableRedisSockets() {
    // Certification processes must not remain alive solely because an external
    // Redis Pub/Sub TCP socket is open. Production Redis connections remain
    // referenced and are still managed explicitly through disconnect().
    if (process.env.VAAYU_TEST_TARGET !== 'disposable') return;

    const clients = [this.pubClient, this.subClient];
    for (const client of clients) {
      const streams = [client?.redis?.stream, client?.subscriber?.stream];
      for (const stream of streams) {
        try {
          if (stream && typeof stream.unref === 'function') stream.unref();
        } catch (_) {}
      }
    }
  }

  async connect() {
    try {
      await this.pubClient.connect();
      await this.subClient.connect();
      this._unrefDisposableRedisSockets();
      this.isConnected = true;
      return true;
    } catch (err) {
      console.warn(`[RedisPubSub] Failed to connect Redis PubSub clients: ${err.message}`);
      this.isConnected = false;
      return false;
    }
  }

  createEventEnvelope(eventType, targetRoom, payload = {}, options = {}) {
    const timestamp = Number.isFinite(Number(options.timestamp)) ? Number(options.timestamp) : Date.now();
    const eventId = typeof options.eventId === 'string' && options.eventId.trim()
      ? options.eventId.trim()
      : `evt_${timestamp}_${crypto.randomBytes(4).toString('hex')}`;
    const entityType = options.entityType || (targetRoom ? targetRoom.split(':')[0] : 'system');
    const entityId = options.entityId || (payload.orderId || payload.tripId || payload.driverId || 'global');

    const sanitizedPayload = { ...payload };
    delete sanitizedPayload.deliveryOtp;
    delete sanitizedPayload.otp;
    delete sanitizedPayload.password;
    delete sanitizedPayload.secret;

    return {
      eventId,
      eventType,
      entityType,
      entityId,
      targetRoom,
      timestamp,
      sourceNode: this.nodeId,
      payload: sanitizedPayload
    };
  }

  async publish(eventType, targetRoom, payload = {}, options = {}) {
    const pubStart = Date.now();
    try {
      const channel = options.channel || this.PRIMARY_CHANNEL;
      const envelope = this.createEventEnvelope(eventType, targetRoom, payload, options);
      const envelopeJson = JSON.stringify(envelope);

      const recipientCount = await this.pubClient.publish(channel, envelopeJson);
      const pubDuration = Date.now() - pubStart;

      metricsService.recordLatency('websocket_publish_latency', pubDuration);
      metricsService.increment('redis_pubsub_publish_total');
      metricsService.increment('websocket_events_published_total');
      logger.info('pubsub_event_published', `PubSub event ${eventType} published to ${targetRoom}`, { eventType, targetRoom, eventId: envelope.eventId });

      return {
        success: true,
        eventId: envelope.eventId,
        sourceNode: this.nodeId,
        recipientCount,
        envelope
      };
    } catch (err) {
      metricsService.increment('redis_pubsub_failure_total');
      metricsService.increment('websocket_pubsub_failures_total');
      logger.warn('pubsub_publish_failed', `Failed to publish event ${eventType}: ${err.message}`, { eventType, targetRoom, error: err.message });
      return { success: false, error: err.message };
    }
  }

  _createSubscriptionWrapper(channel) {
    return (arg1, arg2) => {
      let msgStr;
      if (arg2 !== undefined) {
        if (arg1 !== channel) return;
        msgStr = arg2;
      } else {
        msgStr = arg1;
      }

      try {
        const envelope = typeof msgStr === 'object' && msgStr !== null ? msgStr : JSON.parse(msgStr);
        if (envelope.sourceNode !== this.nodeId) metricsService.increment('cross_node_event_delivery_total');

        const handlers = this.subscriptions.get(channel);
        if (handlers) {
          handlers.forEach(fn => {
            if (envelope.sourceNode === this.nodeId && !fn.allowSelfEvents) return;
            try { fn(envelope); } catch (e) { console.error('[RedisPubSub] Handler execution error:', e); }
          });
        }
      } catch (err) {
        console.warn(`[RedisPubSub] Malformed message received on channel ${channel}: ${err.message}`);
      }
    };
  }

  async subscribe(channel = this.PRIMARY_CHANNEL, handler) {
    if (typeof channel === 'function') {
      handler = channel;
      channel = this.PRIMARY_CHANNEL;
    }
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
      if (!this.channelWrappers) this.channelWrappers = new Map();
      const wrapper = this._createSubscriptionWrapper(channel);
      this.channelWrappers.set(channel, wrapper);
      await this.subClient.subscribe(channel, wrapper);
      this._unrefDisposableRedisSockets();
    }
    this.subscriptions.get(channel).add(handler);
    return true;
  }

  async unsubscribe(channel = this.PRIMARY_CHANNEL, handler = null) {
    if (typeof channel === 'function') {
      handler = channel;
      channel = this.PRIMARY_CHANNEL;
    }
    if (!this.subscriptions.has(channel)) return true;
    if (handler) {
      this.subscriptions.get(channel).delete(handler);
      if (this.subscriptions.get(channel).size === 0) {
        this.subscriptions.delete(channel);
        if (this.channelWrappers) this.channelWrappers.delete(channel);
        await this.subClient.unsubscribe(channel);
      }
    } else {
      this.subscriptions.delete(channel);
      if (this.channelWrappers) this.channelWrappers.delete(channel);
      await this.subClient.unsubscribe(channel);
    }
    return true;
  }

  async resubscribeAll() {
    if (!this.channelWrappers) return;
    for (const [channel, wrapper] of this.channelWrappers.entries()) {
      await this.subClient.subscribe(channel, wrapper);
    }
  }

  async disconnect() {
    this.isConnected = false;
    if (this.pubClient && typeof this.pubClient.disconnect === 'function') await this.pubClient.disconnect();
    if (this.subClient && typeof this.subClient.disconnect === 'function') await this.subClient.disconnect();
  }

  async reset() {
    this.subscriptions.clear();
    if (this.channelWrappers) this.channelWrappers.clear();
    this.isConnected = false;
  }
}

const redisPubSub = new RedisPubSubManager();

module.exports = {
  RedisPubSubManager,
  redisPubSub
};
