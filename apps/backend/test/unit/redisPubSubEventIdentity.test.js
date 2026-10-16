'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RedisPubSubManager } = require('../../src/services/redisPubSub');

test('redis pubsub preserves caller supplied event identity', () => {
  const manager = new RedisPubSubManager({
    nodeId: 'node_test',
    pubClient: {},
    subClient: {},
  });

  const envelope = manager.createEventEnvelope('LIVE_TRIP_LOCATION', 'trip:t1', { tripId: 't1', lat: 17.1 }, {
    eventId: 'evt_fixed_123',
    timestamp: 123456,
  });

  assert.equal(envelope.eventId, 'evt_fixed_123');
  assert.equal(envelope.timestamp, 123456);
  assert.equal(envelope.sourceNode, 'node_test');
  assert.equal(envelope.targetRoom, 'trip:t1');
});

test('redis pubsub still generates unique event identity when caller does not provide one', () => {
  const manager = new RedisPubSubManager({
    nodeId: 'node_test',
    pubClient: {},
    subClient: {},
  });

  const first = manager.createEventEnvelope('EVENT_A', 'trip:t1', {});
  const second = manager.createEventEnvelope('EVENT_A', 'trip:t1', {});

  assert.match(first.eventId, /^evt_\d+_[a-f0-9]{8}$/);
  assert.match(second.eventId, /^evt_\d+_[a-f0-9]{8}$/);
  assert.notEqual(first.eventId, second.eventId);
});
