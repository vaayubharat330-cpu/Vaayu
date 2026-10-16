'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketService } = require('../../src/services/websocketService');

function fakeSocket() {
  return {
    bufferedAmount: 0,
    sent: [],
    send(message) { this.sent.push(message); },
    close() {},
    ping() {},
  };
}

function fakePubSub() {
  return {
    PRIMARY_CHANNEL: 'test:ws',
    async subscribe() {},
    async publish(eventType, targetRoom, payload, options) {
      return {
        success: true,
        eventId: options.eventId,
        envelope: { eventId: options.eventId, timestamp: options.timestamp },
        eventType,
        targetRoom,
        payload,
      };
    },
  };
}

test('websocket local and pubsub delivery share one generated event ID', async () => {
  const service = new WebSocketService(fakePubSub(), { heartbeatIntervalMs: 60_000 });
  const socket = fakeSocket();
  const clientId = service.registerClient(socket, 'DRIVER', 'driver-1', 'DRIVER');
  assert.deepEqual(service.joinRoom(clientId, 'driver:driver-1'), { success: true });

  await service.broadcastToRoom('driver:driver-1', 'DRIVER_LOCATION_UPDATE', { driverId: 'driver-1' });

  assert.equal(socket.sent.length, 1);
  const message = JSON.parse(socket.sent[0]);
  assert.match(message.eventId, /^evt_\d+_[a-f0-9]{12}$/);
  assert.equal(message.event, 'DRIVER_LOCATION_UPDATE');

  clearInterval(service.heartbeatInterval);
  service.unregisterClient(clientId);
});

test('websocket preserves caller-supplied event ID for durable outbox retries', async () => {
  const service = new WebSocketService(fakePubSub(), { heartbeatIntervalMs: 60_000 });
  const socket = fakeSocket();
  const clientId = service.registerClient(socket, 'DRIVER', 'driver-2', 'DRIVER');
  assert.deepEqual(service.joinRoom(clientId, 'driver:driver-2'), { success: true });

  await service.broadcastToRoom(
    'driver:driver-2',
    'PAYMENT_ESCROWED',
    { driverId: 'driver-2' },
    { eventId: 'outbox_evt_123' },
  );

  const message = JSON.parse(socket.sent[0]);
  assert.equal(message.eventId, 'outbox_evt_123');

  clearInterval(service.heartbeatInterval);
  service.unregisterClient(clientId);
});
