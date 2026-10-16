'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketService } = require('../../src/services/websocketService');
const { driverLocationService } = require('../../src/services/driverLocationService');

function createMockSocket() {
  const messages = [];
  return {
    bufferedAmount: 0,
    send(data) { messages.push(JSON.parse(data)); },
    close() {},
    ping() {},
    getMessages() { return messages; }
  };
}

// This suite validates WebSocket telemetry policy only. Use an inert Pub/Sub
// adapter so importing/constructing the service cannot open a real Redis
// subscriber and keep the standalone unit-test process alive.
const testPubSub = {
  PRIMARY_CHANNEL: 'vaayu:test:ws:events',
  async subscribe() { return true; },
  async publish(eventType, targetRoom, payload, options = {}) {
    return {
      success: true,
      eventId: options.eventId,
      envelope: {
        eventType,
        targetRoom,
        timestamp: options.timestamp,
        eventId: options.eventId,
        payload
      }
    };
  }
};

test('historical telemetry replay is persisted but not broadcast as live location', async () => {
  const ws = new WebSocketService(testPubSub, { telemetryLiveMaxPacketAgeMs: 15000 });
  const socket = createMockSocket();
  const clientId = ws.registerClient(socket, 'DRIVER', 'drv_replay_01', 'DRIVER');
  ws.joinRoom(clientId, 'driver:drv_replay_01');

  const original = driverLocationService.updateDriverLocation;
  try {
    driverLocationService.updateDriverLocation = async () => ({
      success: true,
      driver: {
        driverId: 'drv_replay_01',
        currentTripId: 'trip_replay_01',
        lat: 17.4,
        lng: 78.4,
        packetAgeMs: 16001,
        livenessState: 'HEALTHY',
        updatedAt: new Date().toISOString()
      }
    });

    const result = await ws.handleDriverLocationPing('drv_replay_01', {});
    assert.equal(result.success, true);
    assert.equal(result.liveBroadcastSuppressed, true);
    assert.equal(socket.getMessages().length, 0);
  } finally {
    driverLocationService.updateDriverLocation = original;
    if (ws.heartbeatInterval) clearInterval(ws.heartbeatInterval);
  }
});

test('fresh telemetry remains eligible for live broadcast', async () => {
  const ws = new WebSocketService(testPubSub, { telemetryLiveMaxPacketAgeMs: 15000 });
  const socket = createMockSocket();
  const clientId = ws.registerClient(socket, 'DRIVER', 'drv_live_01', 'DRIVER');
  ws.joinRoom(clientId, 'driver:drv_live_01');

  const original = driverLocationService.updateDriverLocation;
  try {
    driverLocationService.updateDriverLocation = async () => ({
      success: true,
      driver: {
        driverId: 'drv_live_01',
        currentTripId: null,
        lat: 17.4,
        lng: 78.4,
        packetAgeMs: 1000,
        livenessState: 'HEALTHY',
        updatedAt: new Date().toISOString()
      }
    });

    const result = await ws.handleDriverLocationPing('drv_live_01', {});
    assert.equal(result.success, true);
    assert.equal(result.liveBroadcastSuppressed, false);
    assert.equal(socket.getMessages().length, 1);
    assert.equal(socket.getMessages()[0].event, 'DRIVER_LOCATION_UPDATE');
  } finally {
    driverLocationService.updateDriverLocation = original;
    if (ws.heartbeatInterval) clearInterval(ws.heartbeatInterval);
  }
});