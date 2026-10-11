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
 */
class WebSocketService {
  constructor(pubSubInstance = null) {
    this.clients = new Map();
    this.rooms = new Map();
    this.pubSub = pubSubInstance || redisPubSub;
    this.initPubSub();
    this.initHeartbeatTimer();
  }

  initHeartbeatTimer() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      this.clients.forEach((client, clientId) => {
        if (now - (client.lastPingMs || 0) > 60000) {
          try {
            if (client.socket && typeof client.socket.close === 'function') {
              client.socket.close();
            }
          } catch(e) {}
          this.unregisterClient(clientId);
        }
      });
    }, 30000);
    if (this.heartbeatInterval.unref) this.heartbeatInterval.unref();
  }

  /**
   * Connects to Redis Pub/Sub and registers cross-node listener
   */
  async initPubSub() {
    if (this.pubSub) {
      await this.pubSub.subscribe(this.pubSub.PRIMARY_CHANNEL, (envelope) => {
        if (envelope && envelope.targetRoom && envelope.eventType) {
          // Deliver to local room subscribers matching target room
          this.broadcastToRoomLocal(envelope.targetRoom, envelope.eventType, envelope.payload);
        }
      });
    }
  }

  /**
   * Registers a new incoming socket connection with authenticated context
   */
  registerClient(socket, clientType = 'UNKNOWN', userId = null, role = 'CUSTOMER', token = null) {
    let verifiedUser = null;
    if (token) {
      verifiedUser = authService.verifyToken(token);
    }

    const effectiveUserId = verifiedUser ? verifiedUser.id : userId;
    const effectiveRole = verifiedUser ? verifiedUser.role : role;
    const effectiveClientType = verifiedUser ? verifiedUser.role : clientType;

    const clientId = `client_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const clientRecord = {
      id: clientId,
      socket,
      rooms: new Set(),
      clientType: effectiveClientType,
      userId: effectiveUserId,
      role: effectiveRole,
      authenticated: Boolean(verifiedUser || userId),
      connectedAt: new Date().toISOString(),
      lastPingMs: Date.now()
    };

    this.clients.set(clientId, clientRecord);
    metricsService.increment('websocket_connections_total');
    metricsService.setGauge('websocket_connections_active', this.clients.size);
    logger.info('websocket_client_connected', `WebSocket client ${clientId} registered`, { clientId, userId: effectiveUserId, role: effectiveRole });

    // Auto-join fleet stream if verified ADMIN
    if (effectiveRole === 'ADMIN' || effectiveClientType === 'FLEET_ADMIN') {
      this.joinRoom(clientId, 'fleet:hyderabad');
    }

    return clientId;
  }

  /**
   * Room Authorization Check Strategy
   */
  authorizeRoomAccess(client, roomName) {
    if (!client) return { authorized: false, reason: 'Client not registered' };

    // 1. Admin/Fleet streams require operator or fleet owner role
    if (roomName.startsWith('fleet:') || roomName.startsWith('admin:')) {
      const isOperator = (client.role || '').includes('ADMIN') || (client.role || '').includes('DISPATCH') || (client.role || '').includes('SUPPORT') || client.role === 'FLEET_OWNER' || client.clientType === 'FLEET_ADMIN' || client.clientType === 'OPERATOR';
      if (isOperator) {
        return { authorized: true };
      }
      return { authorized: false, reason: 'Forbidden: Admin access required for fleet stream' };
    }

    // 2. Driver stream requires matching driverId or fleet owner/admin
    if (roomName.startsWith('driver:')) {
      const targetDriverId = roomName.replace('driver:', '');
      if (client.userId === targetDriverId || client.role === 'ADMIN' || client.role === 'FLEET_OWNER') {
        return { authorized: true };
      }
      return { authorized: false, reason: 'Forbidden: Unauthorized driver stream access' };
    }

    // 3. Customer stream requires matching customerId or admin
    if (roomName.startsWith('customer:')) {
      const targetCustomerId = roomName.replace('customer:', '');
      if (client.userId === targetCustomerId || client.role === 'ADMIN' || client.role === 'SUPER_ADMIN') {
        return { authorized: true };
      }
      return { authorized: false, reason: 'Forbidden: Unauthorized customer stream access' };
    }

    // 4. Trip room requires participant in trip (customer or assigned driver or admin)
    if (roomName.startsWith('trip:')) {
      if (client.role === 'ADMIN' || client.role === 'SUPER_ADMIN' || client.role === 'FLEET_ADMIN') {
        return { authorized: true };
      }
      const tripId = roomName.replace('trip:', '');
      const trip = db.getTripById(tripId);
      const participantId = client.role === 'DRIVER' ? (trip?.driver?.id || trip?.driver?.userId) : trip?.customerId;
      if (trip && participantId && String(client.userId) === String(participantId)) {
        return { authorized: true };
      }
      return { authorized: false, reason: 'Forbidden: Trip subscription authorization failed' };
    }

    return { authorized: false, reason: 'Forbidden: Unknown room' };
  }

  /**
   * Subscribes a client to a room with strict authorization enforcement
   */
  joinRoom(clientId, roomName) {
    const client = this.clients.get(clientId);
    if (!client) return { success: false, error: 'Client connection not found' };

    // Enforce Authorization Audit
    const authCheck = this.authorizeRoomAccess(client, roomName);
    if (!authCheck.authorized) {
      metricsService.increment('websocket_room_join_denied_total');
      metricsService.increment('websocket_authorization_denied_total');
      logger.warn('websocket_room_join_denied', `Unauthorized room join attempt by ${clientId} to ${roomName}`, { clientId, roomName, reason: authCheck.reason });
      console.warn(`[WebSocketService] Unauthorized room join attempt by ${clientId} (${client.userId}) to ${roomName}: ${authCheck.reason}`);
      return { success: false, error: authCheck.reason };
    }

    // Prevent duplicate room additions
    if (client.rooms.has(roomName)) {
      return { success: true, alreadyJoined: true };
    }

    client.rooms.add(roomName);

    if (!this.rooms.has(roomName)) {
      this.rooms.set(roomName, new Set());
    }
    this.rooms.get(roomName).add(clientId);

    return { success: true };
  }

  /**
   * Leaves a room
   */
  leaveRoom(clientId, roomName) {
    const client = this.clients.get(clientId);
    if (client) {
      client.rooms.delete(roomName);
    }

    if (this.rooms.has(roomName)) {
      this.rooms.get(roomName).delete(clientId);
      if (this.rooms.get(roomName).size === 0) {
        this.rooms.delete(roomName);
      }
    }
  }

  /**
   * Unregisters a client on disconnect and cleans up all subscribed rooms
   */
  unregisterClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.rooms.forEach(roomName => {
      if (this.rooms.has(roomName)) {
        this.rooms.get(roomName).delete(clientId);
      }
    });

    this.clients.delete(clientId);
    metricsService.increment('websocket_disconnects_total');
    metricsService.setGauge('websocket_connections_active', this.clients.size);
    logger.info('websocket_client_disconnected', `WebSocket client ${clientId} disconnected`, { clientId });
  }

  /**
   * Broadcasts JSON event payload to local room subscribers ONLY (local sockets)
   */
  broadcastToRoomLocal(roomName, eventName, payload) {
    const subscriberIds = this.rooms.get(roomName);
    if (!subscriberIds || subscriberIds.size === 0) return 0;

    let deliveredCount = 0;
    const messageStr = JSON.stringify({
      event: eventName,
      room: roomName,
      timestamp: new Date().toISOString(),
      data: payload
    });

    for (const clientId of subscriberIds) {
      const client = this.clients.get(clientId);
      if (client && client.socket) {
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
    }

    metricsService.increment('websocket_messages_sent_total', deliveredCount);

    return deliveredCount;
  }

  /**
   * Distributed Broadcast: Delivers locally AND publishes to Redis Pub/Sub for cross-node distribution
   */
  async broadcastToRoom(roomName, eventName, payload, isLocalOnly = false) {
    // 1. Deliver to matching locally connected clients
    const localDelivered = this.broadcastToRoomLocal(roomName, eventName, payload);

    // 2. Publish to distributed Redis Pub/Sub event bus
    if (!isLocalOnly && this.pubSub) {
      try {
        await this.pubSub.publish(eventName, roomName, payload);
      } catch (err) {
        console.warn(`[WebSocketService] Non-critical PubSub publish error: ${err.message}`);
      }
    }

    return localDelivered;
  }

  /**
   * Handles incoming driver GPS location update and triggers partitioned regional streams
   */
  async handleDriverLocationPing(driverId, telemetryData) {
    const result = await driverLocationService.updateDriverLocation(driverId, telemetryData);
    if (!result.success) {
      return { success: false, reason: result.reason };
    }

    const driverState = result.driver;

    // 1. Driver control stream broadcast (`driver:usr_drv_1`)
    this.broadcastToRoom(`driver:${driverId}`, 'DRIVER_LOCATION_UPDATE', driverState);

    // 2. Active trip stream broadcast (`trip:TRIP_XYZ`)
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
        updatedAt: driverState.updatedAt
      });
    }

    // 3. Regional Partitioned Fleet Admin Broadcast (`fleet:hyderabad`, `fleet:all`)
    const city = (telemetryData.city || 'hyderabad').toLowerCase();
    this.broadcastToRoom(`fleet:${city}`, 'FLEET_DRIVER_PING', driverState);
    this.broadcastToRoom('fleet:all', 'FLEET_DRIVER_PING', driverState);

    return {
      success: true,
      driverState
    };
  }
}

const websocketService = new WebSocketService();

module.exports = {
  WebSocketService,
  websocketService
};
