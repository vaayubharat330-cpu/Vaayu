'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PaymentIngestionService } = require('../../src/services/ledger/paymentIngestionService');

function makePool({ existingEvent = null, mapping = null } = {}) {
  const calls = [];
  const eventRows = existingEvent ? [{ ...existingEvent }] : [];
  let nextPk = existingEvent?.event_pk || 40;
  const txClient = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (/SELECT event_pk, status, matched_payment_id, matched_trip_id, amount_paise, payload_hash/.test(sql)) {
        return { rows: eventRows.map(row => ({ ...row })) };
      }
      if (/INSERT INTO payment_provider_events/.test(sql)) {
        if (eventRows.length) return { rows: [] };
        const row = {
          event_pk: ++nextPk,
          provider: params[0],
          provider_event_id: params[1],
          event_type: params[2],
          payload_hash: params[3],
          status: 'RECEIVED',
          matched_payment_id: null,
          matched_trip_id: null,
          amount_paise: params[6],
          currency: params[7],
          idempotent_replay: false
        };
        eventRows.push(row);
        return { rows: [{ event_pk: row.event_pk }] };
      }
      if (/UPDATE payment_provider_events/.test(sql)) {
        const row = eventRows.find(item => item.event_pk === params[params.length - 1] || item.event_pk === params[0]);
        if (row) {
          if (/SET idempotent_replay = TRUE/.test(sql)) row.idempotent_replay = true;
          if (/SET status = 'RECEIVED'/.test(sql)) {
            row.status = 'RECEIVED';
            row.processing_error = null;
            row.processed_at = null;
          }
          if (/SET status = 'PROCESSED'/.test(sql)) {
            row.status = 'PROCESSED';
            row.matched_payment_id = params[0];
            row.matched_trip_id = params[1];
          }
          if (/SET status = 'FAILED'/.test(sql)) row.status = 'FAILED';
        }
        return { rows: [] };
      }
      if (/SELECT \* FROM payment_provider_mappings/.test(sql)) {
        return { rows: mapping ? [{ ...mapping }] : [] };
      }
      if (/UPDATE payment_provider_mappings/.test(sql)) return { rows: [] };
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const pool = {
    pool: { async connect() { return txClient; } },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/UPDATE payment_provider_events/.test(sql)) return txClient.query(sql, params);
      return { rows: [] };
    }
  };
  return { pool, calls, eventRows };
}

function makeProvider() {
  return {
    name: 'razorpay',
    verifyWebhookSignature(rawBody, signature) {
      return signature === 'valid';
    },
    normalizeWebhook(body) {
      return body.normalized;
    }
  };
}

const mapping = {
  mapping_id: 7,
  provider: 'razorpay',
  provider_order_id: 'order-1',
  provider_payment_id: null,
  payment_id: 'PAY-1',
  trip_id: 'TRIP-1',
  order_id: 'ORDER-1',
  customer_id: 'CUS-1',
  expected_amount_paise: 50000,
  currency: 'INR',
  status: 'INITIATED'
};

function body(eventId = 'evt-1') {
  return {
    event_id: eventId,
    normalized: {
      provider: 'razorpay',
      providerEventId: eventId,
      eventType: 'payment.authorized',
      providerPaymentId: 'pay-1',
      providerOrderId: 'order-1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'authorized',
      isCaptured: false,
      isRefunded: false,
      notes: {}
    }
  };
}

test('terminal provider event replay is acknowledged without repeating state mutation', async () => {
  const raw = JSON.stringify(body());
  const { pool, eventRows } = makePool({
    existingEvent: {
      event_pk: 9,
      status: 'PROCESSED',
      payload_hash: require('crypto').createHash('sha256').update(raw).digest('hex'),
      matched_payment_id: 'PAY-1',
      matched_trip_id: 'TRIP-1',
      amount_paise: 50000
    }
  });
  const service = new PaymentIngestionService({ poolOrConfig: pool, providers: new Map([['razorpay', makeProvider()]]) });
  const result = await service.ingestWebhook({ rawBody: raw, signature: 'valid' });
  assert.equal(result.success, true);
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.status, 'PROCESSED');
  assert.equal(eventRows[0].idempotent_replay, true);
});

test('event ID reused with different payload is rejected without replaying financial actions', async () => {
  const original = JSON.stringify(body());
  const { pool } = makePool({
    existingEvent: {
      event_pk: 9,
      status: 'RECEIVED',
      payload_hash: 'different-hash',
      matched_payment_id: 'PAY-1',
      matched_trip_id: 'TRIP-1',
      amount_paise: 50000
    }
  });
  const service = new PaymentIngestionService({ poolOrConfig: pool, providers: new Map([['razorpay', makeProvider()]]) });
  const result = await service.ingestWebhook({ rawBody: original, signature: 'valid' });
  assert.equal(result.success, false);
  assert.equal(result.code, 'STATE_TRANSITION_REJECTED');
});

test('identical retry recovers non-terminal event using same event row', async () => {
  const raw = JSON.stringify(body());
  const { pool, eventRows } = makePool({
    existingEvent: {
      event_pk: 9,
      status: 'FAILED',
      payload_hash: require('crypto').createHash('sha256').update(raw).digest('hex'),
      matched_payment_id: 'PAY-1',
      matched_trip_id: 'TRIP-1',
      amount_paise: 50000
    },
    mapping
  });
  const service = new PaymentIngestionService({ poolOrConfig: pool, providers: new Map([['razorpay', makeProvider()]]) });
  const result = await service.ingestWebhook({ rawBody: raw, signature: 'valid' });
  assert.equal(result.success, true);
  assert.equal(result.status, 'PROCESSED');
  assert.equal(eventRows.length, 1);
  assert.equal(eventRows[0].event_pk, 9);
});

test('payment mapping cannot be reassigned to another customer/trip/amount', async () => {
  const { pool, calls } = makePool({ mapping });
  // Replace mapping registration queries with a minimal transaction-aware fake that returns current mapping.
  const service = new PaymentIngestionService({ poolOrConfig: pool, providers: new Map([['razorpay', makeProvider()]]) });
  await assert.rejects(() => service.registerPaymentMapping({
    provider: 'razorpay',
    providerOrderId: 'order-other',
    paymentId: 'PAY-1',
    tripId: 'TRIP-OTHER',
    customerId: 'CUS-OTHER',
    expectedAmountPaise: 90000
  }), /PAYMENT_MAPPING_CONFLICT/i);
  assert.ok(calls.some(call => /SELECT \* FROM payment_provider_mappings/.test(call.sql)));
});
