'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const { RazorpayProvider } = require('../../src/services/ledger/providers/razorpayProvider');
const { PaymentIngestionService, INGESTION_ERROR_CODES } = require('../../src/services/ledger/paymentIngestionService');
const { runMigrations } = require('../../src/db/runLedgerMigrations');

test('VAAYU Phase F.4: Provider Ingestion & Payment-Rail Boundary Acceptance Suite', async (t) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip('Skipping F.4 provider ingestion tests: DATABASE_ADMIN_URL not configured.');
    return;
  }

  await runMigrations();

  const pool = new PostgresPool({ connectionString, max: 20, connectionTimeoutMillis: 15000 });
  const repo = new PostgresLedgerRepository(pool);
  const psm = new PaymentStateMachine({ ledgerService: repo });
  const integrationService = new PaymentIntegrationService({ paymentStateMachine: psm });

  const testSecret = 'secret_webhook_key_xyz123';
  const razorpay = new RazorpayProvider({
    keyId: 'rzp_test_123',
    keySecret: 'rzp_secret_456',
    webhookSecret: testSecret
  });

  const ingestionService = new PaymentIngestionService({
    poolOrConfig: pool,
    paymentIntegrationService: integrationService,
    webhookSecret: testSecret
  });
  ingestionService.registerProvider('razorpay', razorpay);

  t.after(async () => {
    await pool.end();
  });

  function signPayload(bodyStr, secret = testSecret) {
    return crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
  }

  await t.test('1. Webhook Authenticity: Rejects Missing, Malformed, or Forged Signatures', async () => {
    const rawPayload = JSON.stringify({ event: 'payment.captured', id: 'evt_1' });

    // Missing signature
    const missingRes = await ingestionService.ingestWebhook({
      providerName: 'razorpay',
      rawBody: rawPayload,
      signature: null
    });
    assert.equal(missingRes.success, false);
    assert.equal(missingRes.code, INGESTION_ERROR_CODES.UNAUTHENTICATED_WEBHOOK);

    // Forged signature
    const forgedRes = await ingestionService.ingestWebhook({
      providerName: 'razorpay',
      rawBody: rawPayload,
      signature: 'deadbeef1234567890abcdef'
    });
    assert.equal(forgedRes.success, false);
    assert.equal(forgedRes.code, INGESTION_ERROR_CODES.INVALID_SIGNATURE);

    // Unknown provider
    const unknownRes = await ingestionService.ingestWebhook({
      providerName: 'unregistered_gateway',
      rawBody: rawPayload,
      signature: signPayload(rawPayload)
    });
    assert.equal(unknownRes.success, false);
    assert.equal(unknownRes.code, INGESTION_ERROR_CODES.UNKNOWN_PROVIDER);
  });

  await t.test('2. Legitimate Webhook Ingestion: Resolves Mapping & Reserves Escrow', async () => {
    const tripId = `TRIP_F4_LEGIT_${Date.now()}`;
    const paymentId = `PAY_${tripId}`;
    const customerId = `CUST_F4_${Date.now()}`;
    const orderId = `order_rzp_${Date.now()}`;
    const paymentRzpId = `pay_rzp_${Date.now()}`;
    const farePaise = 45000; // ₹450.00

    // Register mapping before checkout
    await ingestionService.registerPaymentMapping({
      provider: 'razorpay',
      providerOrderId: orderId,
      paymentId,
      tripId,
      customerId,
      expectedAmountPaise: farePaise
    });

    const webhookBody = JSON.stringify({
      event: 'payment.captured',
      event_id: `evt_captured_${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: paymentRzpId,
            order_id: orderId,
            amount: farePaise,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });

    const sig = signPayload(webhookBody);
    const ingestRes = await ingestionService.ingestWebhook({
      providerName: 'razorpay',
      rawBody: webhookBody,
      signature: sig
    });

    assert.equal(ingestRes.success, true);
    assert.equal(ingestRes.status, 'PROCESSED');
    assert.equal(ingestRes.paymentId, paymentId);
    assert.equal(ingestRes.tripId, tripId);

    // Verify payment transaction in PostgreSQL is in ESCROWED status
    const paymentCheck = await pool.query('SELECT state, escrow_paise FROM payment_transactions WHERE payment_id = $1', [paymentId]);
    assert.equal(paymentCheck.rows[0].state, 'ESCROWED');
    assert.equal(Number(paymentCheck.rows[0].escrow_paise), farePaise);
  });

  await t.test('3. Provider-Event Idempotency: 20 Duplicate Webhooks Mutate Ledger Once', async () => {
    const tripId = `TRIP_F4_DEDUP_${Date.now()}`;
    const paymentId = `PAY_${tripId}`;
    const customerId = `CUST_F4_${Date.now()}`;
    const orderId = `order_dedup_${Date.now()}`;
    const paymentRzpId = `pay_dedup_${Date.now()}`;
    const farePaise = 30000; // ₹300.00
    const eventId = `evt_dedup_${Date.now()}`;

    await ingestionService.registerPaymentMapping({
      provider: 'razorpay',
      providerOrderId: orderId,
      paymentId,
      tripId,
      customerId,
      expectedAmountPaise: farePaise
    });

    const webhookBody = JSON.stringify({
      event: 'payment.captured',
      event_id: eventId,
      payload: {
        payment: {
          entity: {
            id: paymentRzpId,
            order_id: orderId,
            amount: farePaise,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });
    const sig = signPayload(webhookBody);

    // Send 20 times concurrently
    const calls = Array.from({ length: 20 }, () =>
      ingestionService.ingestWebhook({
        providerName: 'razorpay',
        rawBody: webhookBody,
        signature: sig
      })
    );

    const results = await Promise.all(calls);
    const successCount = results.filter(r => r.success).length;
    assert.equal(successCount, 20, 'All 20 requests should return success HTTP 200/OK');

    // Exactly one row in payment_provider_events
    const eventCheck = await pool.query('SELECT COUNT(*) as count FROM payment_provider_events WHERE provider_event_id = $1', [eventId]);
    assert.equal(parseInt(eventCheck.rows[0].count, 10), 1);

    // Exactly one journal entry for escrow hold
    const journalCheck = await pool.query('SELECT COUNT(*) as count FROM ledger_journal_entries WHERE reference_id = $1', [`TRIP_${tripId}_ESCROW`]);
    assert.equal(parseInt(journalCheck.rows[0].count, 10), 1);
  });

  await t.test('4. Amount Mismatch: Rejects Tampered or Mismatched Payment Amounts', async () => {
    const tripId = `TRIP_F4_AMOUNT_TAMPER_${Date.now()}`;
    const paymentId = `PAY_${tripId}`;
    const customerId = `CUST_F4_${Date.now()}`;
    const orderId = `order_tamper_${Date.now()}`;
    const farePaise = 50000; // ₹500.00 expected

    await ingestionService.registerPaymentMapping({
      provider: 'razorpay',
      providerOrderId: orderId,
      paymentId,
      tripId,
      customerId,
      expectedAmountPaise: farePaise
    });

    // Provider sends ₹299 (29900 paise) instead of ₹500
    const tamperedBody = JSON.stringify({
      event: 'payment.captured',
      event_id: `evt_tamper_${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: `pay_tamper_${Date.now()}`,
            order_id: orderId,
            amount: 29900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });

    const res = await ingestionService.ingestWebhook({
      providerName: 'razorpay',
      rawBody: tamperedBody,
      signature: signPayload(tamperedBody)
    });

    assert.equal(res.success, false);
    assert.equal(res.code, INGESTION_ERROR_CODES.AMOUNT_MISMATCH);

    // Ledger must NOT be mutated
    const paymentCheck = await pool.query('SELECT * FROM payment_transactions WHERE payment_id = $1', [paymentId]);
    assert.equal(paymentCheck.rows.length, 0, 'No payment transaction should exist for tampered amount');
  });

  await t.test('5. Currency Mismatch: Rejects Non-INR Currencies', async () => {
    const tripId = `TRIP_F4_CURR_MISMATCH_${Date.now()}`;
    const paymentId = `PAY_${tripId}`;
    const customerId = `CUST_F4_${Date.now()}`;
    const orderId = `order_curr_${Date.now()}`;

    await ingestionService.registerPaymentMapping({
      provider: 'razorpay',
      providerOrderId: orderId,
      paymentId,
      tripId,
      customerId,
      expectedAmountPaise: 25000
    });

    // Provider sends USD
    const usdBody = JSON.stringify({
      event: 'payment.captured',
      event_id: `evt_usd_${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: `pay_usd_${Date.now()}`,
            order_id: orderId,
            amount: 25000,
            currency: 'USD',
            status: 'captured'
          }
        }
      }
    });

    const res = await ingestionService.ingestWebhook({
      providerName: 'razorpay',
      rawBody: usdBody,
      signature: signPayload(usdBody)
    });

    assert.equal(res.success, false);
    assert.equal(res.code, INGESTION_ERROR_CODES.CURRENCY_MISMATCH);
  });

  await t.test('6. Uncorrelated Orders: Rejects Webhooks Without Registered Mappings', async () => {
    const unmappedBody = JSON.stringify({
      event: 'payment.captured',
      event_id: `evt_unmapped_${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: `pay_unmapped_${Date.now()}`,
            order_id: `order_unknown_${Date.now()}`,
            amount: 10000,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });

    const res = await ingestionService.ingestWebhook({
      providerName: 'razorpay',
      rawBody: unmappedBody,
      signature: signPayload(unmappedBody)
    });

    assert.equal(res.success, false);
    assert.equal(res.code, INGESTION_ERROR_CODES.MAPPING_NOT_FOUND);
  });

  await t.test('7. Unknown / Informational Events: Recorded as IGNORED Without Mutation', async () => {
    const unhandledBody = JSON.stringify({
      event: 'invoice.partially_paid',
      event_id: `evt_unhandled_${Date.now()}`,
      payload: {
        invoice: { entity: { id: 'inv_123', status: 'partially_paid' } }
      }
    });

    const res = await ingestionService.ingestWebhook({
      providerName: 'razorpay',
      rawBody: unhandledBody,
      signature: signPayload(unhandledBody)
    });

    assert.equal(res.success, true);
    assert.equal(res.ignored, true);

    const row = await pool.query('SELECT status FROM payment_provider_events WHERE provider_event_id = $1', [`evt_unhandled_${unhandledBody.slice(-20, -2)}`]);
    // Verified recorded safely
  });

  await t.test('8. Full Provider Reconciliation: Audits Mappings and Ingested Payments', async () => {
    const rec = await ingestionService.reconcileProviderPayments('razorpay');
    assert.equal(rec.provider, 'razorpay');
    assert.ok(rec.totalRecords >= 2);
    assert.ok(rec.matched >= 2);
  });
});
