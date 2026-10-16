const crypto = require('crypto');
const { driverLocationService } = require('./driverLocationService');
const { redisPubSub } = require('./redisPubSub');
const { authService } = require('./authService');
const { metricsService } = require('./metricsService');
const { logger } = require('./logger');
const db = require('../db/database');

/**
 * VAAYU Production-Hardened Real-Time WebSocket & Distributed Telemetry Stream Manager
 *
 * Features & Hardening:
 * 1. Authenticated Room Access & Authorization Audit (`trip:{tripId}`, `driver:{driverId}`, `fleet:{city}`)
 * 2. Prevent Unauthorized Interception (Customer A cannot join Customer B's trip room)
 * 3. Regional / City Fleet Stream Partitioning (`fleet:hyderabad`, `fleet:bengaluru`)
 * 4. Duplicate Room Subscription & Disconnect Cleanup
 * 5. Redis Pub/Sub Distributed Event Forwarding across Multi-Instance Backend Nodes
 * 6. JWT Handshake Authentication & BOLA Authorization Enforcement
 * 7. Historical telemetry replay is persisted but never flooded into live-map streams.
 * 8. Stable event IDs across local + cross-node delivery, allowing clients to safely deduplicate.
 * 9. Transactional-outbox callers may provide a stable eventId so retries remain deduplicable.
 */
class WebSocketService {
  constructor(pubSubInstance = null, options = {}) {
    this.clients = new Map();
    this.rooms = new Map();
    this.userSessions = new Map();
    this.pubSub = pubSubInstance || redisPubSub;
    this.MAX_BUFFERED_AMOUNT_BYTES = options.maxBufferedAmountBytes || 64 * 1024;
    this.MAX_QUEUE_DEPTH = options.maxQueueDepth || 50;
    this.HEARTBEAT_TIMEOUT_MS = options.heartbeatTimeoutMs || 60000;
    this.HEARTBEAT_INTERVAL_MS = options.heartbeatIntervalMs || 30000;
    this.TELEMETRY_LIVE_MAX_PACKET_AGE_MS = options.telemetryLiveMaxPacketAgeMs || 15000;
    this.SLOW_CONSUMER_DROP_TYPES = new Set([
      'LIVE_TRIP_LOCATION',
      'DRIVER_LOCATION_UPDATE',
      'FLEET_DRIVER_PING'
    ]);

    this.initPubSub();
    this.initHeartbeatTimer();
  }

  initHeartbeatTimer() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      this.clients.forEach((client, clientId) => {
        if (now - (client.lastPingMs || 0) > this.HEARTBEAT_TIMEOUT_MS) {
          logger.warn('websocket_ghost_connection_reaped', `Ghost connection ${clientId} exceeded heartbeat timeout`, { clientId, userId: client.userId });
          try { if (client.socket && typeof client.socket.close === 'function') client.socket.close(1001, 'Heartbeat timeout'); } catch (_) {}
          this.unregisterClient(clientId);
        } else if (client.socket && typeof client.socket.ping === 'function') {
          try { client.socket.ping(); } catch (_) {}
        }
      });
    }, this.HEARTBEAT_INTERVAL_MS);
    if (this.heartbeatInterval.unref) this.heartbeatInterval.unref();
  }

  async initPubSub() {
    if (!this.pubSub) return;
    if (!this._pubSubInitPromise) {
      this._pubSubHandler = envelope => {
        if (envelope && envelope.targetRoom && envelope.eventType) {
          this.broadcastToRoomLocal(envelope.targetRoom, envelope.eventType, envelope.payload, {
            eventId: envelope.eventId,
            timestamp: envelope.timestamp,
          });
        }
      };
      this._pubSubInitPromise = this.pubSub.subscribe(this.pubSub.PRIMARY_CHANNEL, this._pubSubHandler);
    }
    return this._pubSubInitPromise;
  }

  recordPing(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastPingMs = Date.now();
      return true;
    }
    return false;
  }

  registerClient(socket, clientType = 'UNKNOWN', userId = null, role = 'CUSTOMER', token = null) {
    let verifiedUser = null;
    if (token) verifiedUser = authService.verifyToken(token);

    const effectiveUserId = verifiedUser ? verifiedUser.id : userId;
    const effectiveRole = verifiedUser ? verifiedUser.role : role;
    const effectiveClientType = verifiedUser ? verifiedUser.role : clientType;

    if (effectiveUserId && this.userSessions.has(effectiveUserId)) {
      const existingSessions = this.userSessions.get(effectiveUserId);
      for (const oldClientId of existingSessions) {
        const oldClient = this.clients.get(oldClientId);
        if (oldClient && oldClient.socket) {
          logger.info('websocket_duplicate_session_superseded', `Superseding existing session ${oldClientId} for user ${effectiveUserId}`, { oldClientId, userId: effectiveUserId });
          try { if (typeof oldClient.socket.close === 'function') oldClient.socket.close(1000, 'Superseded by new session'); } catch (_) {}
          this.unregisterClient(oldClientId);
        }
      }
    }

    const clientId = `client_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const clientRecord = {
      id: clientId,
      socket,
      rooms: new Set(),
      clientType: effectiveClientType,
      userId: effectiveUserId,
      role: effectiveRole,
      tenantId: verifiedUser ? (verifiedUser.tenantId || verifiedUser.merchantId) : null,
      merchantId: verifiedUser ? (verifiedUser.merchantId || verifiedUser.tenantId) : null,
      authenticated: Boolean(verifiedUser || userId),
      connectedAt: new Date().toISOString(),
      lastPingMs: Date.now(),
      droppedMessagesCount: 0
    };

    this.clients.set(clientId, clientRecord);
    if (effectiveUserId) {
      if (!this.userSessions.has(effectiveUserId)) this.userSessions.set(effectiveUserId, new Set());
      this.userSessions.get(effectiveUserId).add(clientId);
    }

    metricsService.increment('websocket_connections_total');
    metricsService.setGauge('websocket_connections_active', this.clients.size);
    logger.info('websocket_client_connected', `WebSocket client ${clientId} registered`, { clientId, userId: effectiveUserId, role: effectiveRole });

    if (effectiveRole === 'ADMIN' || effectiveClientType === 'FLEET_ADMIN') this.joinRoom(clientId, 'fleet:hyderabad');
    return clientId;
  }

  authorizeRoomAccess(client, roomName) {
    if (!client) return { authorized: false, reason: 'Client not registered' };
    if (roomName.startsWith('fleet:') || roomName.startsWith('admin:')) {
      const isOperator = (client.role || '').includes('ADMIN') || (client.role || '').includes('DISPATCH') || (client.role || '').includes('SUPPORT') || client.role === 'FLEET_OWNER' || client.clientType === 'FLEET_ADMIN' || client.clientType === 'OPERATOR';
      return isOperator ? { authorized: true } : { authorized: false, reason: 'Forbidden: Admin access required for fleet stream' };
    }
    if (roomName.startsWith('driver:')) {
      const targetDriverId = roomName.replace('driver:', '');
      const driver = db.getDrivers ? db.getDrivers().find(d => d.id === targetDriverId || d.userId === targetDriverId) : null;
      const isOwner = client.userId === targetDriverId || (driver && (driver.userId === client.userId || driver.id === client.userId));
      return (isOwner || client.role === 'ADMIN' || client.role === 'FLEET_OWNER') ? { authorized: true } : { authorized: false, reason: 'Forbidden: Unauthorized driver stream access' };
    }
    if (roomName.startsWith('customer:')) {
      const targetCustomerId = roomName.replace('customer:', '');
      return (client.userId === targetCustomerId || client.role === 'ADMIN' || client.role === 'SUPER_ADMIN') ? { authorized: true } : { authorized: false, reason: 'Forbidden: Unauthorized customer stream access' };
    }
    if (roomName.startsWith('tenant:')) {
      const parts = roomName.split(':');
      const targetTenantId = parts[1];
      const clientTenantId = client.tenantId || client.merchantId || (client.role === 'MERCHANT' ? client.userId : null);
      const isTenantAdmin = client.role === 'ADMIN' || client.role === 'SUPER_ADMIN';
      return (isTenantAdmin || (clientTenantId && String(clientTenantId) === String(targetTenantId))) ? { authorized: true } : { authorized: false, reason: 'Forbidden: Tenant room access denied' };
    }
    if (roomName.startsWith('trip:')) {
      if (client.role === 'ADMIN' || client.role === 'SUPER_ADMIN' || client.role === 'FLEET_ADMIN') return { authorized: true };
      const tripId = roomName.replace('trip:', '');
      const trip = db.getTripById(tripId);
      const participantId = client.role === 'DRIVER' ? (trip?.driver?.id || trip?.driver?.userId) : trip?.customerId;
      return (trip && participantId && String(client.userId) === String(participantId)) ? { authorized: true } : { authorized: false, reason: 'Forbidden: Trip subscription authorization failed' };
    }
    return { authorized: false, reason: 'Forbidden: Unknown room' };
  }

  joinRoom(clientId, roomName) {
    const client = this.clients.get(clientId);
    if (!client) return { success: false, error: 'Client connection not found' };
    const authCheck = this.authorizeRoomAccess(client, roomName);
    if (!authCheck.authorized) {
      metricsService.increment('websocket_room_join_denied_total');
      metricsService.increment('websocket_authorization_denied_total');
      logger.warn('websocket_room_join_denied', `Unauthorized room join attempt by ${clientId} to ${roomName}`, { clientId, roomName, reason: authCheck.reason });
      console.warn(`[WebSocketService] Unauthorized room join attempt by ${clientId} (${client.userId}) to ${roomName}: ${authCheck.reason}`);
      return { success: false, error: authCheck.reason };
    }
    if (client.rooms.has(roomName)) return { success: true, alreadyJoined: true };
    client.rooms.add(roomName);
    if (!this.rooms.has(roomName)) this.rooms.set(roomName, new Set());
    this.rooms.get(roomName).add(clientId);
    return { success: true };
  }

  leaveRoom(clientId, roomName) {
    const client = this.clients.get(clientId);
    if (client) client.rooms.delete(roomName);
    if (this.rooms.has(roomName)) {
      this.rooms.get(roomName).delete(clientId);
      if (this.rooms.get(roomName).size === 0) this.rooms.delete(roomName);
    }
  }

  unregisterClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.rooms.forEach(roomName => {
      if (this.rooms.has(roomName)) {
        this.rooms.get(roomName).delete(clientId);
        if (this.rooms.get(roomName).size === 0) this.rooms.delete(roomName);
      }
    });
    if (client.userId && this.userSessions.has(client.userId)) {
      const userSet = this.userSessions.get(client.userId);
      userSet.delete(clientId);
      if (userSet.size === 0) this.userSessions.delete(client.userId);
    }
    this.clients.delete(clientId);
    metricsService.increment('websocket_disconnects_total');
    metricsService.setGauge('websocket_connections_active', this.clients.size);
    logger.info('websocket_client_disconnected', `WebSocket client ${clientId} disconnected`, { clientId });
  }

  async getAuthoritativeActiveTrip(userId, role = 'DRIVER') {
    if (!userId) return null;
    const store = db.getDb();
    const trips = store.trips || [];
    if (role === 'DRIVER') return trips.find(t => (t.driver?.id === userId || t.driver?.userId === userId) && !['DELIVERED', 'CANCELLED', 'FAILED'].includes(t.status)) || null;
    return trips.find(t => t.customerId === userId && !['DELIVERED', 'CANCELLED', 'FAILED'].includes(t.status)) || null;
  }

  broadcastToRoomLocal(roomName, eventName, payload, metadata = {}) {
    const subscriberIds = this.rooms.get(roomName);
    if (!subscriberIds || subscriberIds.size === 0) return 0;
    const eventId = typeof metadata.eventId === 'string' && metadata.eventId.trim() ? metadata.eventId.trim() : `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = Number.isFinite(Number(metadata.timestamp)) ? Number(metadata.timestamp) : Date.now();
    const messageStr = JSON.stringify({ event: eventName, eventId, room: roomName, timestamp: new Date(timestamp).toISOString(), data: payload });
    let deliveredCount = 0;
    for (const clientId of subscriberIds) {
      const client = this.clients.get(clientId);
      if (!client || !client.socket) continue;
      const bufferedBytes = client.socket.bufferedAmount || 0;
      const isSaturated = bufferedBytes > this.MAX_BUFFERED_AMOUNT_BYTES;
      if (isSaturated) {
        const isDroppable = this.SLOW_CONSUMER_DROP_TYPES.has(eventName);
        if (isDroppable) {
          client.droppedMessagesCount = (client.droppedMessagesCount || 0) + 1;
          metricsService.increment('websocket_messages_dropped_total');
          continue;
        }
        logger.warn('websocket_slow_consumer_evicted', `Evicting severely lagged client ${clientId} (${bufferedBytes} bytes buffered)`, { clientId, userId: client.userId, bufferedBytes, eventName });
        metricsService.increment('websocket_slow_consumer_evictions_total');
        try { if (typeof client.socket.close === 'function') client.socket.close(1008, 'Slow consumer backpressure eviction'); } catch (_) {}
        this.unregisterClient(clientId);
        continue;
      }
      try {
        if (typeof client.socket.send === 'function') {
          client.socket.send(messageStr);
          deliveredCount++;
        }
      } catch (err) {
        console.warn(`[WebSocketService] Transport error for ${clientId}, cleaning up:`, err.message);
        this.unregisterClient(clientId);
      }
    }
    metricsService.increment('websocket_messages_sent_total', deliveredCount);
    return deliveredCount;
  }

  async broadcastToRoom(roomName, eventName, payload, options = {}) {
    // Backwards compatibility: older internal callers passed a boolean isLocalOnly flag.
    const isLocalOnly = typeof options === 'boolean' ? options : Boolean(options.isLocalOnly);
    const requestedEventId = typeof options === 'object' && options !== null && typeof options.eventId === 'string' && options.eventId.trim()
      ? options.eventId.trim()
      : null;
    const requestedTimestamp = typeof options === 'object' && options !== null && Number.isFinite(Number(options.timestamp))
      ? Number(options.timestamp)
      : Date.now();
    const eventId = requestedEventId || `evt_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    let publishResult = null;

    if (!isLocalOnly && this.pubSub) {
      publishResult = await this.pubSub.publish(eventName, roomName, payload, { eventId, timestamp: requestedTimestamp });
    }

    return this.broadcastToRoomLocal(roomName, eventName, payload, {
      eventId: publishResult?.eventId || eventId,
      timestamp: publishResult?.envelope?.timestamp || requestedTimestamp,
    });
  }

  async handleDriverLocationPing(driverId, telemetryData) {
    const result = await driverLocationService.updateDriverLocation(driverId, telemetryData);
    if (!result.success) return { success: false, reason: result.reason };
    const driverState = result.driver;
    const packetAgeMs = Number(driverState.packetAgeMs || 0);
    const isHistoricalReplay = packetAgeMs > this.TELEMETRY_LIVE_MAX_PACKET_AGE_MS;
    if (isHistoricalReplay) {
      metricsService.increment('websocket_historical_telemetry_suppressed_total');
      return { success: true, driverState, liveBroadcastSuppressed: true };
    }
    this.broadcastToRoom(`driver:${driverId}`, 'DRIVER_LOCATION_UPDATE', driverState);
    if (driverState.currentTripId) {
      this.broadcastToRoom(`trip:${driverState.currentTripId}`, 'LIVE_TRIP_LOCATION', {
        tripId: driverState.currentTripId,
        driverId,
        lat: driverState.lat,
        lng: driverState.lng,
        bearing: driverState.bearing,
        bearingConfidence: driverState.bearingConfidence,
        speed: driverState.speed,
        livenessState: driverState.livenessState,
        packetAgeMs,
        updatedAt: driverState.updatedAt
      });
    }
    const city = (telemetryData.city || 'hyderabad').toLowerCase();
    this.broadcastToRoom(`fleet:${city}`, 'FLEET_DRIVER_PING', driverState);
    this.broadcastToRoom('fleet:all', 'FLEET_DRIVER_PING', driverState);
    return { success: true, driverState, liveBroadcastSuppressed: false };
  }
}

const websocketService = new WebSocketService();

module.exports = { WebSocketService, websocketService };
