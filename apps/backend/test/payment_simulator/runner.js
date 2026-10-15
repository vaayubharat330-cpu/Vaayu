'use strict';

const { runNormalPaymentTest } = require('./normal_payment');
const { runDuplicatePaymentTest } = require('./duplicate_payment');
const { runConcurrentPaymentTest } = require('./concurrent_payment');
const { runTimeoutSimulationTest } = require('./timeout_simulation');
const { runRefundSimulationTest } = require('./refund_simulation');
const { runPayoutSimulationTest } = require('./payout_simulation');
const { runCrashRecoveryTest } = require('./crash_recovery');
const { runWebsocketFailureTest } = require('./websocket_failure');
const { runHighVolumeReconciliationTest } = require('./reconciliation_test');

async function main() {
  console.log('\n========================================================');
  console.log('       VAAYU PAYMENT CORE & ATTACK SIMULATOR SUITE       ');
  console.log('========================================================\n');

  console.log('Running Attack & Failure Scenarios:');
  console.log('────────────────────────────────────────────────────────');

  const t1 = await runNormalPaymentTest();
  console.log(`[PASS] ${t1.name}`);

  const t2 = await runDuplicatePaymentTest();
  console.log(`[PASS] ${t2.name}`);

  const t3 = await runConcurrentPaymentTest();
  console.log(`[PASS] ${t3.name}`);

  const t4 = await runTimeoutSimulationTest();
  console.log(`[PASS] ${t4.name}`);

  const t5 = await runRefundSimulationTest();
  console.log(`[PASS] ${t5.name}`);

  const t6 = await runPayoutSimulationTest();
  console.log(`[PASS] ${t6.name}`);

  const t7 = await runCrashRecoveryTest();
  console.log(`[PASS] ${t7.name}`);

  const t8 = await runWebsocketFailureTest();
  console.log(`[PASS] ${t8.name}`);

  console.log('────────────────────────────────────────────────────────');
  console.log('Executing High-Volume Synthetic Stress Test...');
  const { metrics, audit } = await runHighVolumeReconciliationTest({ transactionCount: 1000 });
  console.log(`Completed ${metrics.totalAttempts} synthetic operations.\n`);

  console.log('┌──────────────────────────────────────────────┐');
  console.log('│          PAYMENT SIMULATION REPORT           │');
  console.log('├──────────────────────────────────────────────┤');
  console.log(`│ Total Transactions:     ${String(metrics.totalAttempts).padStart(20)} │`);
  console.log(`│ Successful:             ${String(metrics.successful).padStart(20)} │`);
  console.log(`│ Failed (Handled):       ${String(metrics.failed).padStart(20)} │`);
  console.log(`│ Duplicate attempts:     ${String(metrics.duplicateAttempts).padStart(20)} │`);
  console.log(`│ Race conditions:        ${String(metrics.raceConditions).padStart(20)} │`);
  console.log(`│ Double debits:          ${String(metrics.doubleDebits).padStart(20)} │`);
  console.log(`│ Lost transactions:      ${String(metrics.lostTransactions).padStart(20)} │`);
  console.log(`│ Ledger imbalance:       ${String(`₹${metrics.ledgerImbalance}`).padStart(20)} │`);
  console.log(`│ Reconciliation:         ${String(metrics.reconciliation).padStart(20)} │`);
  console.log('└──────────────────────────────────────────────┘\n');

  if (metrics.reconciliation !== 'PASS' || metrics.doubleDebits > 0 || metrics.raceConditions > 0) {
    console.error('FAILED: Invariants violated during simulation!');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal Simulation Error:', err);
  process.exit(1);
});
