'use strict';

// Lightweight delivery-state vocabulary shared by tests and routing boundaries.
// Keep this module dependency-free so importing the state constants never starts
// WebSocket heartbeats, Redis clients, database pools, or other runtime services.
const DELIVERY_STATES = Object.freeze({
  CREATED: 'CREATED',
  SEARCHING_DRIVER: 'SEARCHING_DRIVER',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_ACCEPTED: 'DRIVER_ACCEPTED',
  DRIVER_ARRIVING: 'DRIVER_ARRIVING',
  DRIVER_AT_PICKUP: 'DRIVER_AT_PICKUP',
  PICKUP_CONFIRMED: 'PICKUP_CONFIRMED',
  IN_TRANSIT: 'IN_TRANSIT',
  DRIVER_AT_DROPOFF: 'DRIVER_AT_DROPOFF',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED'
});

module.exports = { DELIVERY_STATES };
