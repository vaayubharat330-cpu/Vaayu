// Per-role transition table tests (PRODUCT_ISSUES.md S5). Uses the state machine directly, with no
// database writes: the table lookup (isActorAuthorized) and state validity (canTransition) are pure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const machine = require(path.join(__dirname, '..', '..', 'src', 'services', 'deliveryStateMachine.js'));
const S = machine.DELIVERY_STATES || {};
const sm = machine.deliveryStateMachine || machine;

test('S5: CUSTOMER may cancel from SEARCHING_DRIVER', () => {
  assert.equal(sm.isActorAuthorized('CUSTOMER', S.SEARCHING_DRIVER, S.CANCELLED), true);
});

test('S5: CUSTOMER may not mark a delivery as delivered', () => {
  assert.equal(sm.isActorAuthorized('CUSTOMER', S.DRIVER_AT_DROPOFF, S.DELIVERED), false);
});

test('S5: CUSTOMER may not move a trip into pickup or transit', () => {
  assert.equal(sm.isActorAuthorized('CUSTOMER', S.DRIVER_AT_PICKUP, S.PICKUP_CONFIRMED), false);
  assert.equal(sm.isActorAuthorized('CUSTOMER', S.IN_TRANSIT, S.DRIVER_AT_DROPOFF), false);
});

test('S5: DRIVER may not cancel a trip', () => {
  assert.equal(sm.isActorAuthorized('DRIVER', S.DRIVER_ARRIVING, S.CANCELLED), false);
});

test('S5: an unknown actor type is refused for every transition', () => {
  assert.equal(sm.isActorAuthorized('UNKNOWN_ROLE', S.SEARCHING_DRIVER, S.CANCELLED), false);
});

// SYSTEM is for internal dispatch only (dispatchService.js). The HTTP route refuses it explicitly.
test('S5: SYSTEM keeps the dispatch transitions it needs internally', () => {
  assert.equal(sm.isActorAuthorized('SYSTEM', S.SEARCHING_DRIVER, S.DRIVER_ASSIGNED), true);
});

test('S5: a skipped state is not a valid transition for anyone', () => {
  assert.equal(sm.canTransition(S.SEARCHING_DRIVER, S.DELIVERED), false);
});
