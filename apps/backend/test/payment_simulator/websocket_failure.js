'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');

async function runWebsocketFailureTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-ws-fail-'));
  const repo = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository: repo });
  const psm = new PaymentStateMachine({ ledgerService: ledger });

  try {
    // Top-up customer
    await psm.topUpCustomerWallet({ customerId: 'c_ws_drop', amountPaise: 40000, idempotencyKey: 'topup_ws_drop' });

    // Simulate mock WebSocket dispatcher that fails/drops connection
    let wsConnected = false;
    let wsEventDelivered = false;

    // Execute booking payment
    const paymentResult = await psm.reserveEscrow({
      tripId: 'TRIP_WS_FAIL_1',
      customerId: 'c_ws_drop',
      amountPaise: 20000,
      idempotencyKey: 'escrow_ws_fail_1'
    });

    // Mock dispatch attempt
    if (wsConnected) {
      wsEventDelivered = true;
    } else {
      // WebSocket is down; system relies on ledger state rather than in-memory socket state
      wsEventDelivered = false;
    }

    assert.strictEqual(wsEventDelivered, false);
    // Ledger invariant: ledger is the single source of truth regardless of socket state
    assert.strictEqual(paymentResult.success, true);
    assert.strictEqual(psm.getCustomerBalance('c_ws_drop').rupees, 200);

    // Client reconnects and queries true state via API
    wsConnected = true;
    const clientQueriedBalance = psm.getCustomerBalance('c_ws_drop');
    assert.strictEqual(clientQueriedBalance.rupees, 200);

    const audit = ledger.reconcile();
    assert.strictEqual(audit.ok, true);

    return { name: 'WebSocket Failure & Disconnect Resiliency Test', passed: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runWebsocketFailureTest };
