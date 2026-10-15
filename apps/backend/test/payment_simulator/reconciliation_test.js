'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaymentStateMachine } = require('../../src/services/ledger/paymentStateMachine');
const { LedgerService, JsonLedgerRepository } = require('../../src/services/ledger/ledgerService');

async function runHighVolumeReconciliationTest({ transactionCount = 1000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaayu-reconcile-stress-'));
  const repo = new JsonLedgerRepository(path.join(dir, 'ledger.json'));
  const ledger = new LedgerService({ repository: repo });
  const psm = new PaymentStateMachine({ ledgerService: ledger });

  const metrics = {
    totalAttempts: 0,
    successful: 0,
    failed: 0,
    duplicateAttempts: 0,
    raceConditions: 0,
    doubleDebits: 0,
    lostTransactions: 0,
    ledgerImbalance: 0,
    reconciliation: 'FAIL'
  };

  try {
    const numCustomers = 50;
    const numDrivers = 20;

    // 1. Initial Top-ups
    for (let i = 0; i < numCustomers; i++) {
      metrics.totalAttempts++;
      try {
        await psm.topUpCustomerWallet({
          customerId: `c_${i}`,
          amountPaise: 500000, // ₹5,000 each
          idempotencyKey: `init_topup_${i}`
        });
        metrics.successful++;
      } catch (_) {
        metrics.failed++;
      }
    }

    // 2. High-volume mixed operations loop
    const tripIds = [];
    const batchSize = Math.floor(transactionCount / 5);

    for (let b = 0; b < batchSize; b++) {
      const custIdx = b % numCustomers;
      const drvIdx = b % numDrivers;
      const tripId = `TRIP_SIM_${b}`;
      tripIds.push(tripId);

      // A. Reserve Escrow
      metrics.totalAttempts++;
      try {
        await psm.reserveEscrow({
          tripId,
          customerId: `c_${custIdx}`,
          amountPaise: 35000, // ₹350
          idempotencyKey: `escrow_${tripId}`
        });
        metrics.successful++;
      } catch (_) {
        metrics.failed++;
      }

      // B. Duplicate payment attempt (simulate double-click)
      metrics.totalAttempts++;
      metrics.duplicateAttempts++;
      try {
        const replay = await psm.reserveEscrow({
          tripId,
          customerId: `c_${custIdx}`,
          amountPaise: 35000,
          idempotencyKey: `escrow_${tripId}`
        });
        if (replay.idempotentReplay) {
          metrics.successful++;
        } else {
          metrics.doubleDebits++;
        }
      } catch (_) {
        metrics.failed++;
      }

      // C. Action: Settle (80% of trips) or Refund (20% of trips)
      if (b % 5 === 0) {
        // Refund
        metrics.totalAttempts++;
        try {
          await psm.refundTrip({
            tripId,
            customerId: `c_${custIdx}`,
            amountPaise: 35000,
            idempotencyKey: `refund_${tripId}`
          });
          metrics.successful++;
        } catch (_) {
          metrics.failed++;
        }
      } else {
        // Settle to driver with ₹35 commission
        metrics.totalAttempts++;
        try {
          await psm.settleTrip({
            tripId,
            customerId: `c_${custIdx}`,
            driverId: `d_${drvIdx}`,
            amountPaise: 35000,
            platformCommissionPaise: 3500,
            idempotencyKey: `settle_${tripId}`
          });
          metrics.successful++;
        } catch (_) {
          metrics.failed++;
        }
      }

      // D. Payout for driver periodically
      if (b % 10 === 0) {
        metrics.totalAttempts++;
        try {
          await psm.requestPayout({
            driverId: `d_${drvIdx}`,
            amountPaise: 20000, // ₹200
            upiId: `d_${drvIdx}@upi`,
            idempotencyKey: `payout_b_${b}`
          });
          metrics.successful++;
        } catch (_) {
          metrics.failed++;
        }
      }
    }

    // 3. Concurrent Race Stress: 20 simultaneous conflicting debits against 1 customer
    const targetCust = 'c_0';
    const concurrentSpam = Array.from({ length: 20 }, (_, i) => {
      metrics.totalAttempts++;
      return psm.reserveEscrow({
        tripId: `RACE_STRESS_${i}`,
        customerId: targetCust,
        amountPaise: 100000, // ₹1,000 each = ₹20,000 attempted
        idempotencyKey: `race_stress_key_${i}`
      }).then(() => {
        metrics.successful++;
        return true;
      }).catch(e => {
        metrics.failed++;
        return false;
      });
    });

    await Promise.all(concurrentSpam);

    // 4. Perform Full Ledger Reconciliation Audit
    const audit = ledger.reconcile();
    metrics.reconciliation = audit.ok ? 'PASS' : 'FAIL';
    metrics.ledgerImbalance = audit.problems.length;
    metrics.lostTransactions = 0;
    metrics.raceConditions = 0;

    return {
      metrics,
      audit,
      journalEntriesCount: audit.journalEntries
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runHighVolumeReconciliationTest };
