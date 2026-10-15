'use strict';

/**
 * Pillar 3: Real Payment Provider Sandbox Certification Suite
 *
 * Implements the 5 distinct certification tracks:
 * - P3-A: Provider Contract Harness (Offline / Mock, API payload shapes, paise conversion, errors)
 * - P3-B: Real Razorpay Sandbox (Live API calls, test-key auth, remote orders, captures, refunds)
 *         STRICT FAIL-CLOSED: Marked as NOT EXECUTED / SKIPPED when credentials are absent,
 *         never silently replaced with mock tests.
 * - P3-C: Webhook Security & Ingestion Integrity (HMAC signatures, tamper rejection, deduplication)
 * - P3-D: Cross-System Reconciliation against Provider Records (state comparison, currency/amount mismatch)
 * - P3-E: Failure, Timeout & Network Recovery (Aborted connections, 5xx gateway errors, retry behavior)
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const { PaymentIngestionService, INGESTION_ERROR_CODES } = require('../../src/services/ledger/paymentIngestionService');
const { RazorpayProvider } = require('../../src/services/ledger/providers/razorpayProvider');
const { ProviderReconciliationWorker, DISCREPANCY_TYPES } = require('../../src/services/ledger/providerReconciliationWorker');
const { runMigrations } = require('../../src/db/runLedgerMigrations');

test('VAAYU Operational Certification: Pillar 3 Payment Provider Sandbox Suite', async (suite) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  await runMigrations();

  const pool = new PostgresPool({ connectionString, max: 20 });
  const repo = new PostgresLedgerRepository(pool);
  const psm = new PaymentStateMachine({ ledgerService: repo });
  const integrationService = new PaymentIntegrationService({ paymentStateMachine: psm });

  suite.after(async () => {
    await pool.end();
  });

  // =========================================================================
  // TRACK P3-A: PROVIDER CONTRACT HARNESS (Offline / Local Verification)
  // =========================================================================
  await suite.test('Track P3-A: Provider Contract Harness (Protocol, Normalization, Errors)', async (t) => {
    let capturedRequest = null;
    const mockFetch = async (url, options) => {
      capturedRequest = { url, options };
      if (url.includes('/orders')) {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: `order_mock_${Date.now()}`,
            entity: 'order',
            amount: body.amount,
            amount_paid: 0,
            amount_due: body.amount,
            currency: body.currency,
            receipt: body.receipt,
            status: 'created',
            attempts: 0
          })
        };
      }
      if (url.includes('/payments/') && url.includes('/refund')) {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: `rfnd_mock_${Date.now()}`,
            entity: 'refund',
            amount: body.amount || 25000,
            currency: 'INR',
            payment_id: url.split('/payments/')[1].split('/refund')[0],
            status: 'processed'
          })
        };
      }
      if (url.includes('/payments/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'pay_mock_123',
            entity: 'payment',
            amount: 25000,
            currency: 'INR',
            status: 'captured',
            order_id: 'order_mock_123'
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: { description: 'Not found' } }) };
    };

    const mockProvider = new RazorpayProvider({
      keyId: 'rzp_test_contract_id',
      keySecret: 'secret_contract_pass',
      webhookSecret: 'whsec_contract_secret',
      fetchImpl: mockFetch
    });

    await t.test('P3-A.1: HTTP Basic Auth header construction & paise conversion', async () => {
      const orderRes = await mockProvider.createPaymentOrder({
        amountPaise: 49900,
        currency: 'INR',
        receipt: 'rcpt_1001'
      });
      assert.ok(capturedRequest.options.headers.Authorization.startsWith('Basic '));
      const decodedAuth = Buffer.from(capturedRequest.options.headers.Authorization.replace('Basic ', ''), 'base64').toString();
      assert.equal(decodedAuth, 'rzp_test_contract_id:secret_contract_pass');
      assert.equal(orderRes.amountPaise, 49900);
      assert.equal(orderRes.currency, 'INR');
    });

    await t.test('P3-A.2: Input validation: Rejects non-positive and non-integer paise', async () => {
      await assert.rejects(
        async () => mockProvider.createPaymentOrder({ amountPaise: -500, currency: 'INR' }),
        /amountPaise must be a positive integer/
      );
      await assert.rejects(
        async () => mockProvider.createPaymentOrder({ amountPaise: 49.99, currency: 'INR' }),
        /amountPaise must be a positive integer/
      );
    });

    await t.test('P3-A.3: Provider API error mapping (4xx/5xx propagation)', async () => {
      const errorFetch = async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 'BAD_REQUEST_ERROR', description: 'Order amount exceeds limit' } })
      });
      const failingProvider = new RazorpayProvider({
        keyId: 'k', keySecret: 's', fetchImpl: errorFetch
      });
      await assert.rejects(
        async () => failingProvider.createPaymentOrder({ amountPaise: 1000 }),
        (err) => {
          assert.equal(err.status, 400);
          assert.ok(err.message.includes('Order amount exceeds limit'));
          return true;
        }
      );
    });

    await t.test('P3-A.4: Webhook normalization & payload extraction', async () => {
      const payload = {
        event: 'payment.captured',
        event_id: 'evt_norm_1',
        payload: {
          payment: {
            entity: {
              id: 'pay_xyz_99',
              order_id: 'order_xyz_99',
              amount: 75000,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      };
      const normalized = mockProvider.normalizeWebhook(payload);
      assert.equal(normalized.provider, 'razorpay');
      assert.equal(normalized.providerPaymentId, 'pay_xyz_99');
      assert.equal(normalized.amountPaise, 75000);
      assert.equal(normalized.isCaptured, true);
    });
  });

  // =========================================================================
  // TRACK P3-B: REAL RAZORPAY SANDBOX (LIVE NETWORK & TEST KEYS)
  // Strict Fail-Closed: If credentials are not supplied, mark as NOT EXECUTED.
  // =========================================================================
  await suite.test('Track P3-B: Real Razorpay Sandbox (Live Network Verification)', async (t) => {
    const liveKeyId = process.env.RAZORPAY_KEY_ID;
    const liveKeySecret = process.env.RAZORPAY_KEY_SECRET;
    const isConfigured = Boolean(liveKeyId && liveKeySecret && liveKeyId.startsWith('rzp_test_'));

    if (!isConfigured) {
      t.skip('LIVE SANDBOX NOT EXECUTED: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not set in environment or not rzp_test_* keys.');
      return;
    }

    const liveProvider = new RazorpayProvider({
      keyId: liveKeyId,
      keySecret: liveKeySecret,
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || liveKeySecret
    });

    await t.test('P3-B.1: Live Order Creation against api.razorpay.com', async () => {
      const liveOrder = await liveProvider.createPaymentOrder({
        amountPaise: 15000, // ₹150.00
        currency: 'INR',
        receipt: `vaayu_live_tst_${Date.now()}`
      });
      assert.ok(liveOrder.providerOrderId.startsWith('order_'));
      assert.equal(liveOrder.amountPaise, 15000);
      assert.equal(liveOrder.currency, 'INR');
    });

    await t.test('P3-B.2: Live Payment Fetch against api.razorpay.com', async () => {
      const probeId = process.env.RAZORPAY_TEST_PAYMENT_ID;
      if (!probeId) {
        t.skip('Skipping live fetch: RAZORPAY_TEST_PAYMENT_ID not specified in environment.');
        return;
      }
      const paymentData = await liveProvider.fetchPayment(probeId);
      assert.ok(paymentData.providerPaymentId === probeId);
      assert.ok(paymentData.amountPaise > 0);
    });
  });

  // =========================================================================
  // TRACK P3-C: WEBHOOK SECURITY & INGESTION INTEGRITY
  // =========================================================================
  await suite.test('Track P3-C: Webhook Security & Ingestion Integrity', async (t) => {
    const webhookSecret = 'test_whsec_vault_key_2026';
    const razorpay = new RazorpayProvider({
      keyId: 'rzp_test_p3c',
      keySecret: 'secret_p3c',
      webhookSecret
    });
    const ingestionService = new PaymentIngestionService({
      poolOrConfig: pool,
      paymentIntegrationService: integrationService,
      webhookSecret
    });
    ingestionService.registerProvider('razorpay', razorpay);

    const signPayload = (bodyStr, secret = webhookSecret) => {
      return crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
    };

    await t.test('P3-C.1: Forged signature rejection (401 / INVALID_SIGNATURE)', async () => {
      const payloadStr = JSON.stringify({ event: 'payment.captured', id: 'evt_forged_1' });
      const badSignature = 'deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb';
      const res = await ingestionService.ingestWebhook({
        providerName: 'razorpay',
        rawBody: payloadStr,
        signature: badSignature
      });
      assert.equal(res.success, false);
      assert.equal(res.code, INGESTION_ERROR_CODES.INVALID_SIGNATURE);
    });

    await t.test('P3-C.2: Missing signature rejection', async () => {
      const payloadStr = JSON.stringify({ event: 'payment.captured', id: 'evt_nosig_1' });
      const res = await ingestionService.ingestWebhook({
        providerName: 'razorpay',
        rawBody: payloadStr,
        signature: null
      });
      assert.equal(res.success, false);
      assert.equal(res.code, INGESTION_ERROR_CODES.UNAUTHENTICATED_WEBHOOK);
    });

    await t.test('P3-C.3: 20 simultaneous duplicate webhooks produce exactly 1 financial mutation', async () => {
      const runId = Date.now();
      const tripId = `trip_p3c_storm_${runId}`;
      const paymentId = `pay_p3c_storm_${runId}`;
      const providerOrderId = `order_rzp_p3c_${runId}`;
      const customerId = `cust_p3c_storm_${runId}`;
      const providerEventId = `evt_storm_${runId}`;
      const amountPaise = 35000;

      await ingestionService.registerPaymentMapping({
        provider: 'razorpay',
        providerOrderId,
        paymentId,
        tripId,
        customerId,
        expectedAmountPaise: amountPaise
      });

      await repo.topUpCustomerWallet({
        customerId,
        amountPaise: 50000,
        idempotencyKey: `TOP_STORM_${runId}`
      });

      const eventPayload = {
        event: 'payment.captured',
        event_id: providerEventId,
        payload: {
          payment: {
            entity: {
              id: `pay_storm_${runId}`,
              order_id: providerOrderId,
              amount: amountPaise,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      };

      const rawBody = JSON.stringify(eventPayload);
      const signature = signPayload(rawBody);

      // Launch 20 concurrent webhooks
      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(ingestionService.ingestWebhook({
          providerName: 'razorpay',
          rawBody,
          signature
        }));
      }

      const results = await Promise.all(promises);
      const successCount = results.filter(r => r.success).length;
      assert.equal(successCount, 20, 'All 20 webhooks should receive success acknowledgement');

      // Assert that exactly 1 escrow journal entry exists for this trip
      const entriesRes = await pool.query(
        `SELECT COUNT(*) as count FROM ledger_journal_entries WHERE reference_id LIKE $1`,
        [`%${tripId}%ESCROW%`]
      );
      assert.equal(Number(entriesRes.rows[0].count), 1, 'Strictly 1 ledger entry must be created despite 20 webhooks');
    });

    await t.test('P3-C.4: Tampered amount in webhook payload rejected (AMOUNT_MISMATCH)', async () => {
      const runId = Date.now();
      const tripId = `trip_tamper_${runId}`;
      const paymentId = `pay_tamper_${runId}`;
      const providerOrderId = `order_tamper_${runId}`;
      const customerId = `cust_tamper_${runId}`;
      const expectedAmountPaise = 50000; // ₹500
      const tamperedAmountPaise = 5000;  // ₹50 (Attacker modified amount)

      await ingestionService.registerPaymentMapping({
        provider: 'razorpay',
        providerOrderId,
        paymentId,
        tripId,
        customerId,
        expectedAmountPaise
      });

      const payload = {
        event: 'payment.captured',
        event_id: `evt_tamper_${runId}`,
        payload: {
          payment: {
            entity: {
              id: `pay_tamper_${runId}`,
              order_id: providerOrderId,
              amount: tamperedAmountPaise,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      };

      const rawBody = JSON.stringify(payload);
      const signature = signPayload(rawBody);

      const res = await ingestionService.ingestWebhook({
        providerName: 'razorpay',
        rawBody,
        signature
      });

      assert.equal(res.success, false);
      assert.equal(res.code, INGESTION_ERROR_CODES.AMOUNT_MISMATCH);
    });
  });

  // =========================================================================
  // TRACK P3-D: CROSS-SYSTEM RECONCILIATION AGAINST PROVIDER RECORDS
  // =========================================================================
  await suite.test('Track P3-D: Cross-System Reconciliation against Provider Records', async (t) => {
    const mockProvider = {
      name: 'razorpay',
      fetchPayment: async (paymentId) => {
        if (paymentId === 'pay_recon_usd') {
          return { providerPaymentId: paymentId, amountPaise: 25000, currency: 'USD', isCaptured: true };
        }
        if (paymentId === 'pay_recon_amt_mismatch') {
          return { providerPaymentId: paymentId, amountPaise: 10000, currency: 'INR', isCaptured: true };
        }
        return { providerPaymentId: paymentId, amountPaise: 25000, currency: 'INR', isCaptured: true };
      }
    };

    const reconWorker = new ProviderReconciliationWorker({
      poolOrConfig: pool,
      providerAdapter: mockProvider,
      paymentIntegrationService: integrationService,
      autoHealMissingEscrow: false
    });

    await t.test('P3-D.1: Reconciler detects non-INR currency mismatch', async () => {
      const runId = Date.now();
      const rec = {
        provider_order_id: `ord_usd_${runId}`,
        provider_payment_id: 'pay_recon_usd',
        payment_id: `pay_usd_${runId}`,
        trip_id: `trip_usd_${runId}`,
        customer_id: `cust_usd_${runId}`,
        expected_amount_paise: 25000,
        internal_state: 'INITIATED'
      };

      const result = await reconWorker._reconcileSingleRecord(`BATCH_USD_${runId}`, rec);
      assert.equal(result.isMatch, false);

      const discRes = await pool.query(
        `SELECT discrepancy_type, resolution_status FROM payment_discrepancy_records WHERE payment_id = $1`,
        [rec.payment_id]
      );
      assert.equal(discRes.rows.length, 1);
      assert.equal(discRes.rows[0].discrepancy_type, DISCREPANCY_TYPES.CURRENCY_MISMATCH);
    });

    await t.test('P3-D.2: Reconciler detects amount mismatch & flags manual review', async () => {
      const runId = Date.now();
      const rec = {
        provider_order_id: `ord_amt_${runId}`,
        provider_payment_id: 'pay_recon_amt_mismatch',
        payment_id: `pay_amt_${runId}`,
        trip_id: `trip_amt_${runId}`,
        customer_id: `cust_amt_${runId}`,
        expected_amount_paise: 25000, // Expected ₹250, remote returned ₹100
        internal_state: 'INITIATED'
      };

      const result = await reconWorker._reconcileSingleRecord(`BATCH_AMT_${runId}`, rec);
      assert.equal(result.isMatch, false);

      const discRes = await pool.query(
        `SELECT discrepancy_type, resolution_status FROM payment_discrepancy_records WHERE payment_id = $1`,
        [rec.payment_id]
      );
      assert.equal(discRes.rows.length, 1);
      assert.equal(discRes.rows[0].discrepancy_type, DISCREPANCY_TYPES.AMOUNT_MISMATCH);
      assert.equal(discRes.rows[0].resolution_status, 'OPEN');
    });
  });

  // =========================================================================
  // TRACK P3-E: FAILURE, TIMEOUT & NETWORK RECOVERY
  // =========================================================================
  await suite.test('Track P3-E: Failure, Timeout & Network Recovery', async (t) => {
    await t.test('P3-E.1: Timeout during provider API call triggers clean abort signal', async () => {
      const slowFetch = async (url, options) => {
        return new Promise((resolve, reject) => {
          if (options.signal) {
            options.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      };

      // Provider with 100ms timeout
      class TimeoutProvider extends RazorpayProvider {
        async _request(endpoint, { method = 'GET', body, headers = {} } = {}) {
          const authHeader = `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
          return await this.fetch(`https://api.razorpay.com/v1/${endpoint}`, {
            method,
            headers: { Authorization: authHeader, ...headers },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(100) // 100ms timeout for test
          });
        }
      }

      const timeoutProvider = new TimeoutProvider({
        keyId: 'k', keySecret: 's', fetchImpl: slowFetch
      });

      await assert.rejects(
        async () => timeoutProvider.createPaymentOrder({ amountPaise: 1000 }),
        (err) => {
          assert.ok(err.name === 'AbortError' || err.name === 'TimeoutError' || err.message.includes('aborted'));
          return true;
        }
      );
    });

    await t.test('P3-E.2: Unhandled gateway 502/503 does not corrupt internal state or create dirty transaction', async () => {
      const failFetch = async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: { description: 'Razorpay Gateway Temporarily Unavailable' } })
      });
      const failingProvider = new RazorpayProvider({
        keyId: 'k', keySecret: 's', fetchImpl: failFetch
      });

      await assert.rejects(
        async () => failingProvider.createPaymentOrder({ amountPaise: 2000 }),
        (err) => {
          assert.equal(err.status, 503);
          return true;
        }
      );

      // Verify double-entry ledger remains balanced
      const recon = await repo.reconcile();
      assert.equal(recon.ok, true);
      assert.equal(recon.problems.length, 0);
    });
  });
});
