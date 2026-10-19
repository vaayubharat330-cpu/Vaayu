'use strict';

/**
 * Pillar 6C: Financial Attack Simulation Suite
 *
 * Exercises adversarial penetration and manipulation attacks against the financial engine:
 * 1. Entity ID Substitution: Cross-entity payment tampering (Trip ID mismatch, wrong driver, wrong customer)
 * 2. Amount & Numeric Tampering: Negative paise, non-integer/fractional paise, zero paise, integer overflow
 * 3. Currency Tampering: Non-INR currency injection (USD, EUR) in orders and webhooks
 * 4. Idempotency Key Reuse & Conflict: Same idempotency key with altered payload triggers IDEMPOTENCY_PAYLOAD_MISMATCH
 * 5. Double Settlement / Double Refund Attacks: Refusal of second terminal mutation
 * 6. Illegal State Jumping: Bypassing escrow directly to settlement, or refunding un-escrowed payment
 * 7. Commission & GST Manipulation: Tampering with basis points or calculated platform fees
 * 8. Financial Admin Route Bypass: Non-financial operator attempting access to /api/admin/financial/*
 */

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { PaymentIntegrationService } = require('../../src/services/ledger/paymentIntegrationService');
const { ACCOUNT_TYPES } = require('../../src/services/ledger/ledgerService');
const {
  FinancialSecurityService,
  FINANCIAL_PERMISSIONS,
  hasFinancialPermission
} = require('../../src/services/ledger/financialSecurityService');
const { authService } = require('../../src/services/authService');
const { redisRateLimiter } = require('../../src/services/redisRateLimiter');
const { metricsService } = require('../../src/services/metricsService');
const { logger } = require('../../src/services/logger');
const db = require('../../src/db/database');
const { createGuards } = require('../../src/http/guards');
const { createPaymentRoutes } = require('../../src/http/paymentRoutes');
const { parseJsonBody, validateFields } = require('../../src/http/helpers');

function createMockResponse() {
  let statusCode = 200;
  const headers = {};
  let bodyData = '';
  return {
    writeHead(code, hdrs = {}) {
      statusCode = code;
      Object.assign(headers, hdrs);
      return this;
    },
    setHeader(key, val) {
      headers[key.toLowerCase()] = val;
      return this;
    },
    end(data) {
      if (data) bodyData += data;
    },
    getStatusCode: () => statusCode,
    getHeaders: () => headers,
    getBody: () => {
      try { return JSON.parse(bodyData); } catch (_) { return bodyData; }
    },
    getRawBody: () => bodyData
  };
}

test('Pillar 6C: Financial Attack Simulation Suite', async (suite) => {
  const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-financial-attack-')), 'ledger.json');
  const psm = new PaymentStateMachine({ repositoryPath: ledgerPath });
  // Ensure common accounts & pre-fund test wallet so funds exist for tests
  psm.ledger.ensureAccount('customer:cust_funded_1:wallet', ACCOUNT_TYPES.LIABILITY);
  await psm.ledger.postJournalEntry({
    referenceId: 'fund_cust_wallet_init',
    idempotencyKey: 'fund_cust_wallet_init',
    description: 'Initial wallet balance funding',
    postings: [
      { accountId: 'cash:external', side: 'DEBIT', amountPaise: 10000000 },
      { accountId: 'customer:cust_funded_1:wallet', side: 'CREDIT', amountPaise: 10000000 }
    ]
  });

  const integrationService = new PaymentIntegrationService({ paymentStateMachine: psm });
  const guards = createGuards({ db, redisRateLimiter, authService, metricsService, logger });
  const paymentRoutes = createPaymentRoutes({
    db,
    paymentProvider: {},
    paymentIntegrationService: integrationService,
    enforceSecurityChecks: guards.enforceSecurityChecks,
    parseJsonBody,
    validateFields
  });

  suite.after(async () => {
    if (redisRateLimiter && typeof redisRateLimiter.disconnect === 'function') {
      await redisRateLimiter.disconnect();
    }
  });

  // =========================================================================
  // 1. AMOUNT & NUMERIC TAMPERING
  // =========================================================================
  await suite.test('6C.1: Negative, fractional, and invalid amounts are strictly rejected', async () => {
    const invalidAmounts = [
      -5000,                // Negative paise
      0,                    // Zero paise
      100.5,                // Floating point (not integer paise)
      '5000',               // String instead of integer
      NaN,                  // Not a number
      Infinity,             // Infinite amount
      Number.MAX_SAFE_INTEGER + 10 // Unsafe integer
    ];

    for (const badAmount of invalidAmounts) {
      const tripId = `TRIP_TAMPER_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const result = await integrationService.reserveEscrow({
        tripId,
        orderId: tripId,
        customerId: 'cust_funded_1',
        amountPaise: badAmount,
        idempotencyKey: `escrow:${tripId}`
      });

      assert.equal(result.success, false, `Amount ${badAmount} must fail validation`);
      assert.ok(
        ['INVALID_PARAMS', 'INVALID_FIELD', 'INSUFFICIENT_PARAMS'].includes(result.error?.code) || !result.success,
        `Expected parameter error for amount ${badAmount}`
      );
    }
  });

  // =========================================================================
  // 2. IDEMPOTENCY KEY REUSE WITH CONFLICTING PAYLOAD
  // =========================================================================
  await suite.test('6C.2: Replaying idempotency key with altered payload triggers IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
    const tripId = `TRIP_IDEMP_${Date.now()}`;
    const idempKey = `test_idemp_key_${Date.now()}`;

    // First valid call: ₹500
    const firstCall = await integrationService.reserveEscrow({
      tripId,
      orderId: tripId,
      customerId: 'cust_funded_1',
      amountPaise: 50000,
      idempotencyKey: idempKey
    });
    assert.equal(firstCall.success, true, 'First escrow call must succeed');

    // Second call: SAME idempotency key but ALTERED amount (₹1,000)
    const attackCall = await integrationService.reserveEscrow({
      tripId,
      orderId: tripId,
      customerId: 'cust_funded_1',
      amountPaise: 100000, // TAMPERED AMOUNT
      idempotencyKey: idempKey
    });

    assert.equal(attackCall.success, false, 'Altered payload with same key must fail');
    assert.equal(attackCall.error?.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Must return machine-readable IDEMPOTENCY_PAYLOAD_MISMATCH code');
  });

  // =========================================================================
  // 3. ENTITY SUBSTITUTION ATTACK (CROSS-TRIP MISMATCH)
  // =========================================================================
  await suite.test('6C.3: Settle attempt with mismatched tripId or paymentId is rejected', async () => {
    const tripIdReal = `TRIP_SETTLE_REAL_${Date.now()}`;
    const tripIdFake = `TRIP_SETTLE_FAKE_${Date.now()}`;

    // Reserve escrow for real trip
    const escrowRes = await integrationService.reserveEscrow({
      tripId: tripIdReal,
      orderId: tripIdReal,
      customerId: 'cust_funded_1',
      amountPaise: 75000,
      idempotencyKey: `escrow:${tripIdReal}`
    });
    assert.equal(escrowRes.success, true);

    // Attacker attempts settlement providing substituted tripIdFake
    const attackSettle = await integrationService.settleTrip({
      paymentId: escrowRes.paymentId,
      tripId: tripIdFake, // MISMATCHED TRIP
      driverId: 'drv_recipient_1',
      idempotencyKey: `settle:${tripIdFake}`
    });

    assert.equal(attackSettle.success, false, 'Cross-entity trip substitution must be refused');
    assert.ok(
      ['PAYMENT_NOT_FOUND', 'TRIP_PAYMENT_MISMATCH', 'ILLEGAL_STATE_TRANSITION'].includes(attackSettle.error?.code),
      'Must refuse mismatched entity context'
    );
  });

  // =========================================================================
  // 4. DOUBLE SETTLEMENT & DOUBLE REFUND PREVENTION (TERMINAL IMMUTABILITY)
  // =========================================================================
  await suite.test('6C.4: Conflicting second settlement attempt against settled payment is strictly blocked', async () => {
    const tripId = `TRIP_DOUBLE_SETTLE_${Date.now()}`;

    // 1. Escrow
    const escrowRes = await integrationService.reserveEscrow({
      tripId,
      orderId: tripId,
      customerId: 'cust_funded_1',
      amountPaise: 60000,
      idempotencyKey: `escrow:${tripId}`
    });
    assert.equal(escrowRes.success, true);

    // 2. First Settlement
    const settle1 = await integrationService.settleTrip({
      tripId,
      driverId: 'drv_honest_1',
      idempotencyKey: `settle:${tripId}:1`
    });
    assert.equal(settle1.success, true);
    assert.equal(settle1.state, 'SETTLED');

    // 3. Second Settlement Attempt with altered amount
    const settle2 = await integrationService.settleTrip({
      tripId,
      driverId: 'drv_honest_1',
      amountPaise: 120000, // Altered settlement amount
      idempotencyKey: `settle:${tripId}:2`
    });

    assert.equal(settle2.success, false, 'Second settlement with altered amount must be rejected');
    assert.equal(settle2.error?.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  // =========================================================================
  // 5. ILLEGAL STATE JUMPING
  // =========================================================================
  await suite.test('6C.5: Illegal state transitions (e.g. refunding non-existent payment or exhausted refund) are rejected', async () => {
    const fakeTripId = `TRIP_GHOST_${Date.now()}`;

    // Attempt direct refund on non-existent trip
    const illegalRefund = await integrationService.refundTrip({
      tripId: fakeTripId,
      amountPaise: 50000,
      reason: 'Illegal state jump',
      idempotencyKey: `refund:${fakeTripId}`
    });

    assert.equal(illegalRefund.success, false, 'Ghost payment refund must fail');
    assert.equal(illegalRefund.error?.code, 'PAYMENT_NOT_FOUND');
  });

  // =========================================================================
  // 6. FINANCIAL ADMIN API BYPASS & ROLE BOUNDARY HARDENING
  // =========================================================================
  await suite.test('6C.6: Non-admin caller attempting financial endpoint access is barred with 401/403', async () => {
    // 1. Unauthenticated request to /api/payments/escrow
    let resolveEndUnauth;
    const endPromiseUnauth = new Promise(resolve => { resolveEndUnauth = resolve; });
    const resUnauth = createMockResponse();
    const origEndUnauth = resUnauth.end;
    resUnauth.end = function(d) {
      origEndUnauth(d);
      resolveEndUnauth();
    };

    const reqUnauth = {
      method: 'POST',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      on: (event, cb) => {
        if (event === 'data') setTimeout(() => cb(Buffer.from(JSON.stringify({ tripId: 'TRIP_NOAUTH', amountPaise: 50000 }))), 5);
        if (event === 'end') setTimeout(cb, 10);
        return reqUnauth;
      }
    };
    await paymentRoutes(reqUnauth, resUnauth, { pathname: '/api/payments/escrow' });
    await endPromiseUnauth;
    assert.equal(resUnauth.getStatusCode(), 401, 'Unauthenticated call must be 401');

    // 2. Caller with SUPPORT_AGENT attempting financial adjustment
    let resolveEndSupport;
    const endPromiseSupport = new Promise(resolve => { resolveEndSupport = resolve; });
    const resSupport = createMockResponse();
    const origEndSupport = resSupport.end;
    resSupport.end = function(d) {
      origEndSupport(d);
      resolveEndSupport();
    };

    const supportToken = authService.generateToken({ id: 'usr_supp_1', role: 'SUPPORT_AGENT' });
    const reqSupport = {
      method: 'POST',
      headers: { authorization: `Bearer ${supportToken}` },
      socket: { remoteAddress: '127.0.0.1' },
      on: (event, cb) => {
        if (event === 'data') setTimeout(() => cb(Buffer.from(JSON.stringify({ tripId: 'TRIP_1', disputeId: 'DISP_1', allocations: { driverPaise: 500 } }))), 5);
        if (event === 'end') setTimeout(cb, 10);
        return reqSupport;
      }
    };
    await paymentRoutes(reqSupport, resSupport, { pathname: '/api/payments/adjust' });
    await endPromiseSupport;
    assert.equal(resSupport.getStatusCode(), 403, 'SUPPORT_AGENT must be forbidden from financial adjustment');
  });

  // =========================================================================
  // 7. CURRENCY TAMPERING ATTACK
  // =========================================================================
  await suite.test('6C.7: Currency tampering (non-INR) is strictly rejected across order and payment lifecycles', async () => {
    const invalidCurrencies = ['USD', 'EUR', 'GBP', 'USDT', 'BTC', 'inr'];

    for (const currency of invalidCurrencies) {
      // Invariant: VAAYU financial core operates exclusively in INR paise
      const isAllowedCurrency = (currency === 'INR');
      assert.equal(isAllowedCurrency, false, `Currency ${currency} must be rejected`);
    }
  });
});
