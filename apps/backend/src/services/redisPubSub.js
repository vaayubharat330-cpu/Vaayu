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
 */
class RedisPubSubManager {
  constructor(options = {}) {
    this.nodeId = options.nodeId || `node_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
    this.pubClient = options.pubClient || new RedisClient();
    this.subClient = options.subClient || new RedisClient(); // Dedicated subscriber connection
    this.PRIMARY_CHANNEL = 'vaayu:ws:events';
    this.subscriptions = new Map(); // channel -> Set<handler>
    this.isConnected = false;
  }

  /**
   * Connects publisher and dedicated subscriber connections
   */
  async connect() {
    try {
      await this.pubClient.connect();
      await this.subClient.connect();
      this.isConnected = true;
      return true;
    } catch (err) {
      console.warn(`[RedisPubSub] Failed to connect Redis PubSub clients: ${err.message}`);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Formats raw business payload into a standardized event envelope
   */
  createEventEnvelope(eventType, targetRoom, payload = {}, options = {}) {
    const timestamp = Date.now();
    const eventId = `evt_${timestamp}_${crypto.randomBytes(4).toString('hex')}`;
    const entityType = options.entityType || (targetRoom ? targetRoom.split(':')[0] : 'system');
    const entityId = options.entityId || (payload.orderId || payload.tripId || payload.driverId || 'global');

    // Sanitize payload to remove sensitive information
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

  /**
   * Publishes event envelope to Redis Pub/Sub channel
   */
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

      // Best-effort delivery failure semantics: return false without throwing
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Internal subscription wrapper creation
   */
  _createSubscriptionWrapper(channel) {
    return (chan, msgStr) => {
      if (chan !== channel) return;
      try {
        const envelope = JSON.parse(msgStr);
        if (envelope.sourceNode !== this.nodeId) {
          metricsService.increment('cross_node_event_delivery_total');
        }

        const handlers = this.subscriptions.get(channel);
        if (handlers) {
          handlers.forEach(fn => {
            // Loop Prevention: Skip execution if event originated from this node unless handler explicitly allows self events
            if (envelope.sourceNode === this.nodeId && !fn.allowSelfEvents) {
              return;
            }
            try { fn(envelope); } catch(e) { console.error('[RedisPubSub] Handler execution error:', e); }
          });
        }
      } catch (err) {
        console.warn(`[RedisPubSub] Malformed message received on channel ${channel}: ${err.message}`);
      }
    };
  }

  /**
   * Subscribes a handler to a Redis Pub/Sub channel with envelope deserialization and loop prevention
   */
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

      // Register underlying Redis subscription
      await this.subClient.subscribe(channel, wrapper);
    }

    this.subscriptions.get(channel).add(handler);
    return true;
  }

  /**
   * Unsubscribes a handler from a Redis Pub/Sub channel
   */
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

  /**
   * Resubscribes all active handlers upon connection recovery
   */
  async resubscribeAll() {
    if (!this.channelWrappers) return;
    for (const [channel, wrapper] of this.channelWrappers.entries()) {
      await this.subClient.subscribe(channel, wrapper);
    }
  }

  async disconnect() {
    this.isConnected = false;
    // Preserves this.subscriptions & this.channelWrappers so resubscribeAll can re-establish them upon connection recovery
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
