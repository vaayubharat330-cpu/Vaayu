'use strict';

const crypto = require('crypto');
const { PostgresPool } = require('../../db/postgresClient');
const { metricsService } = require('../metricsService');
const { logger } = require('../logger');

/**
 * Standard Ingestion Error Codes
 */
const INGESTION_ERROR_CODES = Object.freeze({
  UNAUTHENTICATED_WEBHOOK: 'UNAUTHENTICATED_WEBHOOK',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  MALFORMED_PAYLOAD: 'MALFORMED_PAYLOAD',
  UNKNOWN_PROVIDER: 'UNKNOWN_PROVIDER',
  UNSUPPORTED_EVENT_TYPE: 'UNSUPPORTED_EVENT_TYPE',
  MAPPING_NOT_FOUND: 'MAPPING_NOT_FOUND',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  STATE_TRANSITION_REJECTED: 'STATE_TRANSITION_REJECTED',
  PROVIDER_OUTAGE: 'PROVIDER_OUTAGE',
  DUPLICATE_EVENT_REPLAY: 'DUPLICATE_EVENT_REPLAY'
});

/**
 * VAAYU PAYMENT INGESTION SERVICE (Phase F.4)
 * 
 * Sits securely at the payment-rail boundary between external providers and the
 * internal VAAYU Payment Integration Service / Ledger Core.
 * 
 * Hardening Guarantees:
 * 1. Webhook Authenticity: Timing-safe HMAC verification against configured secrets.
 * 2. Provider-Event Idempotency: Duplicate webhooks (same provider + provider_event_id)
 *    are recorded as idempotent replays with 0 ledger mutations.
 * 3. Payment/Order Correlation: Never trust client parameters; resolves mapped trip/customer
 *    via `payment_provider_mappings`.
 * 4. Amount Verification: Rejects any deviation between expected paise and provider reported paise.
 * 5. Currency Verification: Rejects non-INR / unexpected currency callbacks.
 * 6. Controlled State Transitions: Maps verified provider captured events into explicit
 *    `reserveEscrow` or settlement commands via `PaymentIntegrationService`.
 * 7. Unknown / Unhandled Events: Recorded in `payment_provider_events` as 'IGNORED' without ledger mutation.
 */
class PaymentIngestionService {
  constructor({
    poolOrConfig,
    paymentIntegrationService,
    providers = new Map(),
    webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET,
    loggerInstance = null
  } = {}) {
    if (poolOrConfig && typeof poolOrConfig.query === 'function') {
      this.pool = poolOrConfig;
    } else {
      this.pool = new PostgresPool(poolOrConfig || {});
    }

    this.integrationService = paymentIntegrationService;
    this.providers = providers;
    this.webhookSecret = webhookSecret;
    this.logger = loggerInstance || logger;
  }

  registerProvider(name, providerInstance) {
    this.providers.set(name.toLowerCase(), providerInstance);
  }

  getProvider(name) {
    return this.providers.get((name || '').toLowerCase());
  }

  _hashPayload(rawBody) {
    const str = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  /**
   * Register a new pre-payment order mapping (e.g. when order is created before checkout)
   */
  async registerPaymentMapping({
    provider = 'razorpay',
    providerOrderId,
    paymentId,
    tripId,
    orderId = null,
    customerId,
    expectedAmountPaise,
    currency = 'INR'
  }) {
    if (!providerOrderId || !paymentId || !tripId || !customerId || !expectedAmountPaise) {
      throw new Error('providerOrderId, paymentId, tripId, customerId, and expectedAmountPaise are required.');
    }

    const sql = `
      INSERT INTO payment_provider_mappings (
        provider, provider_order_id, payment_id, trip_id, order_id,
        customer_id, expected_amount_paise, currency, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'INITIATED', NOW(), NOW())
      ON CONFLICT (payment_id) DO UPDATE SET
        provider_order_id = EXCLUDED.provider_order_id,
        expected_amount_paise = EXCLUDED.expected_amount_paise,
        updated_at = NOW()
      RETURNING *;
    `;

    const res = await this.pool.query(sql, [
      provider,
      providerOrderId,
      paymentId,
      tripId,
      orderId || tripId,
      customerId,
      expectedAmountPaise,
      currency
    ]);

    return res.rows[0];
  }

  /**
   * Main Ingestion Gateway for incoming Webhooks
   */
  async ingestWebhook({
    providerName = 'razorpay',
    rawBody,
    signature,
    secret = this.webhookSecret
  }) {
    const provider = this.getProvider(providerName);
    if (!provider) {
      return {
        success: false,
        code: INGESTION_ERROR_CODES.UNKNOWN_PROVIDER,
        message: `Unknown payment provider: ${providerName}`
      };
    }

    // 1. Authenticate Signature
    if (!signature) {
      return {
        success: false,
        code: INGESTION_ERROR_CODES.UNAUTHENTICATED_WEBHOOK,
        message: 'Missing provider webhook signature header.'
      };
    }

    const isAuthentic = provider.verifyWebhookSignature(rawBody, signature, secret);
    if (!isAuthentic) {
      metricsService.increment('provider_webhook_invalid_signature_total');
      return {
        success: false,
        code: INGESTION_ERROR_CODES.INVALID_SIGNATURE,
        message: 'Cryptographic signature verification failed.'
      };
    }

    // 2. Parse & Normalize Payload
    let parsedBody;
    try {
      parsedBody = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    } catch (e) {
      return {
        success: false,
        code: INGESTION_ERROR_CODES.MALFORMED_PAYLOAD,
        message: 'Malformed JSON webhook payload.'
      };
    }

    let normalized;
    try {
      normalized = provider.normalizeWebhook(parsedBody);
    } catch (e) {
      return {
        success: false,
        code: INGESTION_ERROR_CODES.MALFORMED_PAYLOAD,
        message: `Failed to normalize provider payload: ${e.message}`
      };
    }

    const payloadHash = this._hashPayload(rawBody);

    // 3. Atomically Record & Check Idempotency in payment_provider_events
    let eventPk = null;
    let mapping = null;
    const client = await this.pool.pool.connect();
    try {
      await client.query('BEGIN');

      // Acquire transaction-scoped advisory lock on provider event to prevent race between concurrent duplicate deliveries
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PROVIDER_EVENT:${provider.name}:${normalized.providerEventId}`]);

      // Check if event already exists
      const existingRes = await client.query(`
        SELECT event_pk, status, matched_payment_id, matched_trip_id, amount_paise
        FROM payment_provider_events
        WHERE provider = $1 AND provider_event_id = $2
        FOR UPDATE;
      `, [provider.name, normalized.providerEventId]);

      if (existingRes.rows.length > 0) {
        // Idempotent Replay!
        await client.query('COMMIT');
        metricsService.increment('provider_webhook_duplicate_replays_total');
        return {
          success: true,
          idempotentReplay: true,
          code: INGESTION_ERROR_CODES.DUPLICATE_EVENT_REPLAY,
          eventId: normalized.providerEventId,
          status: existingRes.rows[0].status,
          paymentId: existingRes.rows[0].matched_payment_id,
          message: 'Webhook event already processed. Idempotent replay acknowledged.'
        };
      }

      // Record new event in RECEIVED status
      const insertEventSql = `
        INSERT INTO payment_provider_events (
          provider, provider_event_id, event_type, payload_hash, raw_payload,
          signature, status, amount_paise, currency, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'RECEIVED', $7, $8, NOW())
        ON CONFLICT (provider, provider_event_id) DO NOTHING
        RETURNING event_pk;
      `;
      const eventInsertRes = await client.query(insertEventSql, [
        provider.name,
        normalized.providerEventId,
        normalized.eventType,
        payloadHash,
        JSON.stringify(parsedBody),
        signature,
        normalized.amountPaise,
        normalized.currency
      ]);

      if (eventInsertRes.rows.length === 0) {
        // Raced and lost just before lock
        const recheckRes = await client.query(`
          SELECT event_pk, status, matched_payment_id, matched_trip_id, amount_paise
          FROM payment_provider_events
          WHERE provider = $1 AND provider_event_id = $2;
        `, [provider.name, normalized.providerEventId]);
        await client.query('COMMIT');
        metricsService.increment('provider_webhook_duplicate_replays_total');
        return {
          success: true,
          idempotentReplay: true,
          code: INGESTION_ERROR_CODES.DUPLICATE_EVENT_REPLAY,
          eventId: normalized.providerEventId,
          status: recheckRes.rows[0]?.status || 'PROCESSED',
          paymentId: recheckRes.rows[0]?.matched_payment_id,
          message: 'Webhook event already processed. Idempotent replay acknowledged.'
        };
      }

      eventPk = eventInsertRes.rows[0].event_pk;

      // 4. Handle Unhandled / Informational Event Types
      const supportedEvents = ['payment.captured', 'payment.authorized', 'payment.failed', 'refund.processed'];
      if (!supportedEvents.includes(normalized.eventType)) {
        await client.query(`
          UPDATE payment_provider_events
          SET status = 'IGNORED',
              processing_error = $1,
              processed_at = NOW()
          WHERE event_pk = $2;
        `, [`Unhandled event type: ${normalized.eventType}`, eventPk]);
        await client.query('COMMIT');

        return {
          success: true,
          ignored: true,
          eventType: normalized.eventType,
          message: `Event type ${normalized.eventType} recorded as IGNORED without financial mutation.`
        };
      }

      // 5. Correlate with Internal Payment Order Mapping
      if (normalized.providerOrderId) {
        const mapRes = await client.query(`
          SELECT * FROM payment_provider_mappings
          WHERE provider = $1 AND provider_order_id = $2
          FOR UPDATE;
        `, [provider.name, normalized.providerOrderId]);
        if (mapRes.rows.length > 0) mapping = mapRes.rows[0];
      }

      if (!mapping && normalized.notes?.paymentId) {
        const mapRes = await client.query(`
          SELECT * FROM payment_provider_mappings
          WHERE payment_id = $1
          FOR UPDATE;
        `, [normalized.notes.paymentId]);
        if (mapRes.rows.length > 0) mapping = mapRes.rows[0];
      }

      if (!mapping) {
        // Unknown correlation: Reject financial mutation
        await client.query(`
          UPDATE payment_provider_events
          SET status = 'FAILED',
              processing_error = 'No internal payment mapping found for provider order',
              processed_at = NOW()
          WHERE event_pk = $1;
        `, [eventPk]);
        await client.query('COMMIT');

        return {
          success: false,
          code: INGESTION_ERROR_CODES.MAPPING_NOT_FOUND,
          message: `No payment mapping found for provider order ${normalized.providerOrderId}`
        };
      }

      // 6. Currency Verification
      if (normalized.currency && normalized.currency !== mapping.currency) {
        await client.query(`
          UPDATE payment_provider_events
          SET status = 'FAILED',
              matched_payment_id = $1,
              matched_trip_id = $2,
              processing_error = $3,
              processed_at = NOW()
          WHERE event_pk = $4;
        `, [mapping.payment_id, mapping.trip_id, `Currency mismatch: expected ${mapping.currency}, got ${normalized.currency}`, eventPk]);
        await client.query('COMMIT');

        return {
          success: false,
          code: INGESTION_ERROR_CODES.CURRENCY_MISMATCH,
          message: `Currency mismatch: expected ${mapping.currency}, got ${normalized.currency}`
        };
      }

      // 7. Amount Verification
      if (normalized.amountPaise !== null && Number(normalized.amountPaise) !== Number(mapping.expected_amount_paise)) {
        await client.query(`
          UPDATE payment_provider_events
          SET status = 'FAILED',
              matched_payment_id = $1,
              matched_trip_id = $2,
              processing_error = $3,
              processed_at = NOW()
          WHERE event_pk = $4;
        `, [
          mapping.payment_id,
          mapping.trip_id,
          `Amount mismatch: expected ${mapping.expected_amount_paise} paise, got ${normalized.amountPaise} paise`,
          eventPk
        ]);
        await client.query('COMMIT');

        return {
          success: false,
          code: INGESTION_ERROR_CODES.AMOUNT_MISMATCH,
          message: `Amount mismatch: expected ${mapping.expected_amount_paise} paise, got ${normalized.amountPaise} paise`
        };
      }

      // 8. Update mapping with provider payment ID
      await client.query(`
        UPDATE payment_provider_mappings
        SET provider_payment_id = $1,
            status = $2,
            updated_at = NOW()
        WHERE mapping_id = $3;
      `, [normalized.providerPaymentId, normalized.isCaptured ? 'CAPTURED' : mapping.status, mapping.mapping_id]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // 9. Execute Internal Financial State Machine Action (outside ingestion lock transaction)
    let psmResult = null;
    if (normalized.isCaptured && this.integrationService) {
      const rawEventKey = `${provider.name}:${normalized.providerEventId}`;
      const hashSuffix = crypto.createHash('sha256').update(rawEventKey).digest('hex').slice(0, 40);
      const escrowKey = `INGEST:${hashSuffix}`;
      const topUpKey = `TOPUP:${hashSuffix}`;

      // Top up customer wallet first with exact captured amount
      if (this.integrationService.psm?.ledger) {
        await this.integrationService.psm.ledger.topUpCustomerWallet({
          customerId: mapping.customer_id,
          amountPaise: Number(mapping.expected_amount_paise),
          idempotencyKey: topUpKey,
          metadata: {
            provider: provider.name,
            providerPaymentId: normalized.providerPaymentId,
            providerEventId: normalized.providerEventId
          }
        });
      }

      // Reserve Escrow Hold
      psmResult = await this.integrationService.reserveEscrow({
        tripId: mapping.trip_id,
        orderId: mapping.order_id,
        customerId: mapping.customer_id,
        amountPaise: Number(mapping.expected_amount_paise),
        idempotencyKey: escrowKey
      });

      if (!psmResult.success && !psmResult.idempotentReplay) {
        await this.pool.query(`
          UPDATE payment_provider_events
          SET status = 'FAILED',
              matched_payment_id = $1,
              matched_trip_id = $2,
              processing_error = $3,
              processed_at = NOW()
          WHERE event_pk = $4;
        `, [mapping.payment_id, mapping.trip_id, psmResult.error?.message || 'PSM transition rejected', eventPk]);

        return {
          success: false,
          code: INGESTION_ERROR_CODES.STATE_TRANSITION_REJECTED,
          error: psmResult.error
        };
      }
    }

    // Mark Event as PROCESSED
    await this.pool.query(`
      UPDATE payment_provider_events
      SET status = 'PROCESSED',
          matched_payment_id = $1,
          matched_trip_id = $2,
          processed_at = NOW()
      WHERE event_pk = $3;
    `, [mapping.payment_id, mapping.trip_id, eventPk]);

    metricsService.increment('provider_webhook_ingested_success_total');
    return {
      success: true,
      eventId: normalized.providerEventId,
      paymentId: mapping.payment_id,
      tripId: mapping.trip_id,
      status: 'PROCESSED',
      psmResult
    };
  }

  /**
   * Reconcile external provider settlement/payments against internal database
   */
  async reconcileProviderPayments(providerName = 'razorpay') {
    const query = `
      SELECT m.mapping_id, m.provider, m.provider_order_id, m.provider_payment_id,
             m.payment_id, m.trip_id, m.expected_amount_paise, m.status as mapping_status,
             e.status as event_status, e.amount_paise as ingested_amount_paise,
             t.state as ledger_state, t.escrow_paise, t.driver_earnings_paise
      FROM payment_provider_mappings m
      LEFT JOIN payment_provider_events e ON e.matched_payment_id = m.payment_id
      LEFT JOIN payment_transactions t ON t.payment_id = m.payment_id
      WHERE m.provider = $1;
    `;
    const res = await this.pool.query(query, [providerName]);
    const items = res.rows;

    let matched = 0;
    let mismatches = 0;

    for (const row of items) {
      const amountMatches = row.ingested_amount_paise === null || Number(row.expected_amount_paise) === Number(row.ingested_amount_paise);
      if (amountMatches && (row.event_status === 'PROCESSED' || row.mapping_status === 'INITIATED')) {
        matched++;
      } else {
        mismatches++;
      }
    }

    return {
      provider: providerName,
      totalRecords: items.length,
      matched,
      mismatches,
      isBalanced: mismatches === 0
    };
  }
}

module.exports = {
  PaymentIngestionService,
  INGESTION_ERROR_CODES
};
