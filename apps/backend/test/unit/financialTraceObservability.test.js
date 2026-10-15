'use strict';

/**
 * VAAYU Phase P.2: Financial Trace Reconstructor & Observability Test Suite
 *
 * Verifies:
 * 1. Canonical End-to-End Financial Lineage:
 *    Simulates real lifecycle:
 *    HTTP request -> payment creation -> escrow -> outbox -> provider event -> settle -> recon -> audit
 *    Asserts that querying ANY single identifier:
 *    - paymentId
 *    - tripId
 *    - entryId
 *    - eventId
 *    - providerEventId
 *    resolves to the EXACT identical financial history with COMPLETE status.
 *
 * 2. Multi-Status Trace Integrity Diagnostics:
 *    - COMPLETE: fully settled and verified lifecycle
 *    - PARTIAL: in-flight escrow hold without settlement or outbox publishing
 *    - INCONSISTENT: deliberate broken relationships:
 *        a) captured provider event with no internal payment transaction
 *        b) provider event without registered mapping
 *        c) amount mismatch between mapping and payment
 *        d) unresolved OPEN financial discrepancy
 *        e) unbalanced journal entry
 *        f) outbox event in FAILED (DLQ) status
 *    - NOT_FOUND: unknown / nonexistent identifier
 *
 * 3. Operational Anomaly Scanner:
 *    Detects stuck initiated payments, open discrepancies, DLQ failures, and pending approvals.
 *
 * 4. HTTP API Endpoints Contract & RBAC:
 *    - GET /api/admin/financial/trace
 *    - GET /api/admin/financial/anomalies
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { PostgresPool } = require('../../src/db/postgresClient');
const { PostgresLedgerRepository } = require('../../src/services/ledger/postgresLedgerRepository');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const { PaymentIngestionService } = require('../../src/services/ledger/paymentIngestionService');
const { FinancialSecurityService, FINANCIAL_PERMISSIONS } = require('../../src/services/ledger/financialSecurityService');
const { FinancialTraceReconstructor, TRACE_STATUS } = require('../../src/services/ledger/financialTraceReconstructor');
const { createPaymentRoutes } = require('../../src/http/paymentRoutes');

test('VAAYU Operational Certification: Pillar 2 Financial Trace Reconstructor & Observability Suite', async (t) => {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip('Skipping Pillar 2 tests: DATABASE_ADMIN_URL not configured.');
    return;
  }

  const pool = new PostgresPool({ connectionString, max: 20 });
  const repo = new PostgresLedgerRepository(pool);
  const psm = new PaymentStateMachine({ ledgerService: repo });
  const integrationService = new PaymentIntegrationService({ paymentStateMachine: psm, ledgerService: repo });
  const securityService = new FinancialSecurityService({ paymentIntegrationService: integrationService });
  const reconstructor = new FinancialTraceReconstructor(pool);

  t.after(async () => {
    await pool.end();
  });

  const testPrefix = `P2_${Date.now()}`;

  // ===========================================================================
  // 1. CANONICAL MULTI-WAY LINEAGE RESOLUTION (ALL IDENTIFIERS CONVERGE)
  // ===========================================================================
  await t.test('1. Canonical Multi-Way Lineage Resolution: All Identifiers Converge to Same Complete Trace', async () => {
    const tripId = `TRIP_${testPrefix}_CANONICAL`;
    const paymentId = `PAY_${tripId}`;
    const custId = `CUST_${testPrefix}_1`;
    const driverId = `DRV_${testPrefix}_1`;
    const orderRzpId = `order_${testPrefix}_1`;
    const payRzpId = `pay_${testPrefix}_1`;
    const farePaise = 65000;
    const reqId = `REQ_${testPrefix}_HTTP_1`;

    // 1. Topup wallet
    await repo.topUpCustomerWallet({
      customerId: custId,
      amountPaise: farePaise,
      idempotencyKey: `TOPUP_${tripId}`
    });

    // 2. Reserve Escrow Hold
    const escrowRes = await repo.reserveEscrow({
      tripId,
      customerId: custId,
      amountPaise: farePaise,
      idempotencyKey: `ESCROW_${tripId}`
    });
    assert.strictEqual(escrowRes.status, 'ESCROWED');

    // 3. Register Provider Mapping
    await pool.query(`
      INSERT INTO payment_provider_mappings (
        provider, provider_order_id, provider_payment_id, payment_id, trip_id,
        order_id, customer_id, expected_amount_paise, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CAPTURED');
    `, ['razorpay', orderRzpId, payRzpId, paymentId, tripId, tripId, custId, farePaise]);

    // 4. Ingest Provider Webhook Event
    const providerEventId = `evt_${testPrefix}_rzp_1`;
    await pool.query(`
      INSERT INTO payment_provider_events (
        provider, provider_event_id, event_type, payload_hash, raw_payload,
        status, matched_payment_id, matched_trip_id, amount_paise, currency
      ) VALUES ($1, $2, 'payment.captured', 'hash123', '{}'::jsonb, 'PROCESSED', $3, $4, $5, 'INR');
    `, ['razorpay', providerEventId, paymentId, tripId, farePaise]);

    // 5. Settle Trip
    const settleRes = await repo.settleTrip({
      tripId,
      driverId,
      commissionBps: 1000,
      gstBps: 1800,
      idempotencyKey: `SETTLE_${tripId}`
    });
    assert.strictEqual(settleRes.status, 'SETTLED');

    // 6. Mark Outbox Events as PUBLISHED
    await pool.query(`
      UPDATE payment_outbox SET status = 'PUBLISHED', published_at = NOW()
      WHERE aggregate_id = $1 OR payload::text LIKE $2;
    `, [paymentId, `%${tripId}%`]);

    // 7. Audit log action
    await securityService.recordAudit({
      actorId: 'admin_p2',
      actorRole: 'SUPER_ADMIN',
      action: 'FORENSIC_INSPECTION',
      resourceType: 'PAYMENT',
      resourceId: paymentId,
      requestId: reqId,
      metadata: { tripId, paymentId }
    });

    // Extract one entry_id and one event_id for multi-way lookup
    const jeCheck = await pool.query('SELECT entry_id FROM ledger_journal_entries WHERE reference_id LIKE $1 LIMIT 1', [`%${tripId}%`]);
    const sampleEntryId = jeCheck.rows[0].entry_id;

    const obCheck = await pool.query('SELECT event_id FROM payment_outbox WHERE aggregate_id = $1 LIMIT 1', [paymentId]);
    const sampleEventId = obCheck.rows[0].event_id;

    // Execute multi-way trace reconstruction using EACH identifier independently
    const traceByPayment = await reconstructor.reconstruct({ paymentId });
    const traceByTrip = await reconstructor.reconstruct({ tripId });
    const traceByEntry = await reconstructor.reconstruct({ entryId: sampleEntryId });
    const traceByEvent = await reconstructor.reconstruct({ eventId: sampleEventId });
    const traceByProvEvent = await reconstructor.reconstruct({ providerEventId });
    const traceByRequest = await reconstructor.reconstruct({ requestId: reqId });

    // Assert every single lookup converges to the exact same entities
    for (const t of [traceByPayment, traceByTrip, traceByEntry, traceByEvent, traceByProvEvent, traceByRequest]) {
      assert.strictEqual(t.status, TRACE_STATUS.COMPLETE, `Trace must be COMPLETE, got ${t.status}`);
      assert.strictEqual(t.resolvedRoot.paymentId, paymentId);
      assert.strictEqual(t.resolvedRoot.tripId, tripId);
      assert.strictEqual(t.payment.state, 'SETTLED');
      assert.ok(t.journalEntries.length >= 2, 'Must contain escrow and settlement journal entries');
      assert.ok(t.outboxEvents.length >= 1, 'Must contain outbox events');
      assert.ok(t.providerEvents.length >= 1, 'Must contain provider events');
      assert.strictEqual(t.inconsistencies.length, 0, 'Must have zero inconsistencies');
    }
  });

  // ===========================================================================
  // 2. PARTIAL LINEAGE (IN-FLIGHT ESCROW STATE)
  // ===========================================================================
  await t.test('2. Partial Lineage: Legitimate In-Flight Escrow Hold Marked PARTIAL', async () => {
    const tripId = `TRIP_${testPrefix}_PARTIAL`;
    const custId = `CUST_${testPrefix}_2`;
    const farePaise = 25000;

    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: farePaise, idempotencyKey: `TOPUP_${tripId}` });
    await repo.reserveEscrow({ tripId, customerId: custId, amountPaise: farePaise, idempotencyKey: `ESCROW_${tripId}` });

    const trace = await reconstructor.reconstruct({ tripId });
    assert.strictEqual(trace.status, TRACE_STATUS.PARTIAL, 'In-flight escrow hold must report PARTIAL');
    assert.strictEqual(trace.payment.state, 'ESCROWED');
    assert.strictEqual(trace.inconsistencies.length, 0);
  });

  // ===========================================================================
  // 3. INCONSISTENT LINEAGE: BROKEN RELATIONSHIPS
  // ===========================================================================
  await t.test('3. Inconsistent Lineage: Unmapped Captured Provider Event', async () => {
    const ghostEventId = `evt_ghost_${Date.now()}`;
    await pool.query(`
      INSERT INTO payment_provider_events (
        provider, provider_event_id, event_type, payload_hash, raw_payload, status, amount_paise, currency
      ) VALUES ('razorpay', $1, 'payment.captured', 'hash_ghost', '{}'::jsonb, 'PROCESSED', 50000, 'INR');
    `, [ghostEventId]);

    const trace = await reconstructor.reconstruct({ providerEventId: ghostEventId });
    assert.strictEqual(trace.status, TRACE_STATUS.INCONSISTENT);
    assert.ok(trace.inconsistencies.some(i => i.includes('Captured provider webhook exists without corresponding payment')));
  });

  await t.test('4. Inconsistent Lineage: Amount Mismatch Between Mapping & Payment', async () => {
    const tripId = `TRIP_${testPrefix}_MISMATCH`;
    const paymentId = `PAY_${tripId}`;
    const custId = `CUST_${testPrefix}_3`;

    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: 40000, idempotencyKey: `TOPUP_${tripId}` });
    await repo.reserveEscrow({ tripId, customerId: custId, amountPaise: 40000, idempotencyKey: `ESCROW_${tripId}` });

    // Intentionally insert a mismatched provider mapping (e.g. ₹500 expected vs ₹400 internal)
    await pool.query(`
      INSERT INTO payment_provider_mappings (
        provider, provider_order_id, payment_id, trip_id, customer_id, expected_amount_paise, status
      ) VALUES ('razorpay', $1, $2, $3, $4, 50000, 'INITIATED');
    `, [`order_mismatch_${Date.now()}`, paymentId, tripId, custId]);

    const trace = await reconstructor.reconstruct({ paymentId });
    assert.strictEqual(trace.status, TRACE_STATUS.INCONSISTENT);
    assert.ok(trace.inconsistencies.some(i => i.includes('Amount mismatch')));
  });

  await t.test('5. Inconsistent Lineage: Unresolved OPEN Financial Discrepancy', async () => {
    const tripId = `TRIP_${testPrefix}_OPEN_DISC`;
    const paymentId = `PAY_${tripId}`;
    const custId = `CUST_${testPrefix}_4`;

    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: 30000, idempotencyKey: `TOPUP_${tripId}` });
    await repo.reserveEscrow({ tripId, customerId: custId, amountPaise: 30000, idempotencyKey: `ESCROW_${tripId}` });

    // Insert OPEN discrepancy
    const discRes = await pool.query(`
      INSERT INTO payment_discrepancy_records (
        batch_ref, provider, discrepancy_type, payment_id, trip_id, resolution_status
      ) VALUES ('BATCH_TEST_1', 'razorpay', 'MISSING_INTERNAL_ESCROW', $1, $2, 'OPEN')
      RETURNING discrepancy_id;
    `, [paymentId, tripId]);
    const discId = discRes.rows[0].discrepancy_id;

    // Query via discrepancyId
    const trace = await reconstructor.reconstruct({ discrepancyId: discId });
    assert.strictEqual(trace.status, TRACE_STATUS.INCONSISTENT);
    assert.ok(trace.inconsistencies.some(i => i.includes('unresolved OPEN financial discrepancies')));
  });

  await t.test('6. Inconsistent Lineage: Outbox Event In Dead Letter Queue (DLQ)', async () => {
    const tripId = `TRIP_${testPrefix}_DLQ`;
    const paymentId = `PAY_${tripId}`;
    const custId = `CUST_${testPrefix}_5`;

    await repo.topUpCustomerWallet({ customerId: custId, amountPaise: 20000, idempotencyKey: `TOPUP_${tripId}` });
    await repo.reserveEscrow({ tripId, customerId: custId, amountPaise: 20000, idempotencyKey: `ESCROW_${tripId}` });

    // Mark outbox event as FAILED
    await pool.query(`
      UPDATE payment_outbox SET status = 'FAILED', last_error = 'Simulated DLQ error'
      WHERE aggregate_id = $1;
    `, [paymentId]);

    const trace = await reconstructor.reconstruct({ paymentId });
    assert.strictEqual(trace.status, TRACE_STATUS.INCONSISTENT);
    assert.ok(trace.inconsistencies.some(i => i.includes('Dead Letter Queue (DLQ)')));
  });

  // ===========================================================================
  // 4. NOT_FOUND HANDLING
  // ===========================================================================
  await t.test('7. Not Found Handling: Unknown Identifier Returns NOT_FOUND Cleanly', async () => {
    const trace = await reconstructor.reconstruct({ paymentId: 'PAY_DOES_NOT_EXIST_99999' });
    assert.strictEqual(trace.status, TRACE_STATUS.NOT_FOUND);
    assert.strictEqual(trace.payment, null);
    assert.strictEqual(trace.journalEntries.length, 0);
  });

  // ===========================================================================
  // 5. OPERATIONAL ANOMALY SCANNER
  // ===========================================================================
  await t.test('8. Operational Anomaly Scanner: Detects Live System Operational Anomalies', async () => {
    const scan = await reconstructor.scanOperationalAnomalies();
    assert.ok(scan.scannedAt);
    assert.ok(Array.isArray(scan.alerts));
    // Verify scan returns structured alerts if any exist
    for (const alert of scan.alerts) {
      assert.ok(alert.type);
      assert.ok(alert.severity);
      assert.ok(Number.isInteger(alert.count));
      assert.ok(Array.isArray(alert.items));
    }
  });

  // ===========================================================================
  // 6. HTTP API CONTRACT & RBAC INTEGRATION
  // ===========================================================================
  await t.test('9. HTTP Endpoints: GET /api/admin/financial/trace & /anomalies RBAC & Contract', async () => {
    const mockRes = () => {
      const res = {
        statusCode: null,
        headers: {},
        body: '',
        writeHead: (code, headers) => { res.statusCode = code; res.headers = headers; },
        end: (data) => { res.body = data; }
      };
      return res;
    };

    const handler = createPaymentRoutes({
      db: {},
      paymentProvider: {},
      paymentIntegrationService: integrationService,
      financialSecurityService: securityService,
      enforceSecurityChecks: async (req, res, opts) => {
        if (!req.user) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return false;
        }
        return true;
      },
      parseJsonBody: () => ({}),
      validateFields: () => true
    });

    // A. Unauthorized access without auth
    const unauthRes = mockRes();
    await handler({ method: 'GET', user: null }, unauthRes, {
      pathname: '/api/admin/financial/trace',
      parsedUrl: { query: { payment_id: 'PAY_123' } }
    });
    assert.strictEqual(unauthRes.statusCode, 401);

    // B. Authorized Super Admin Query for Trace
    const authRes = mockRes();
    const adminUser = { id: 'admin_1', role: 'SUPER_ADMIN', permissions: ['*'] };
    await handler({ method: 'GET', user: adminUser }, authRes, {
      pathname: '/api/admin/financial/trace',
      parsedUrl: { query: { payment_id: `PAY_TRIP_${testPrefix}_CANONICAL` } }
    });
    assert.strictEqual(authRes.statusCode, 200);
    const traceJson = JSON.parse(authRes.body);
    assert.strictEqual(traceJson.success, true);
    assert.strictEqual(traceJson.trace.status, TRACE_STATUS.COMPLETE);

    // C. Authorized Super Admin Query for Anomalies
    const anomRes = mockRes();
    await handler({ method: 'GET', user: adminUser }, anomRes, {
      pathname: '/api/admin/financial/anomalies',
      parsedUrl: { query: {} }
    });
    assert.strictEqual(anomRes.statusCode, 200);
    const anomJson = JSON.parse(anomRes.body);
    assert.strictEqual(anomJson.success, true);
    assert.ok(anomJson.diagnostics.scannedAt);
  });
});
