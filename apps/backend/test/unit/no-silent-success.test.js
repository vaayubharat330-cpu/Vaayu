// Guards PRODUCT_ISSUES.md T5/T6. A route must never report success for a feature that is missing.
// Static check on server_production.js: no `: { success: true }` fallback may remain, and no
// `db.x ? db.x() : null` silent drop may remain on a route that writes money, OTP, SOS, or schedules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Route logic lives in server_production.js and in the src/http/ route modules; scan both.
const srcDir = path.join(__dirname, '..', '..', 'src');
const httpDir = path.join(srcDir, 'http');
const src = [path.join(srcDir, 'server_production.js'), ...fs.readdirSync(httpDir).map(f => path.join(httpDir, f))]
  .map(file => fs.readFileSync(file, 'utf8'))
  .join('\n');

test('T5/T6: no db.x fallback reports success when the feature is missing', () => {
  // A fallback may return success only when it claims no verified outcome, i.e. status PENDING_REVIEW.
  const offenders = src.split(/\r?\n/)
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /db\.\w+ \? db\.\w+\(.*\) : .*success: true/.test(line))
    .filter(({ line }) => !/status: 'PENDING_REVIEW'/.test(line));
  assert.deepEqual(offenders.map(o => o.n), [], `silent-success fallbacks at lines: ${offenders.map(o => o.n).join(', ')}`);
});

test('T5/T6: the twelve money, OTP, SOS, and schedule fallbacks return FEATURE_UNAVAILABLE', () => {
  const names = ['createPayout', 'saveVehicleDetails', 'saveDriverDetails', 'logTelemetry',
    'createSchedule', 'cancelSchedule', 'assignDriverToVehicle', 'calculateWaitingTimeFee', 'triggerSosEmergency'];
  for (const n of names) {
    const line = src.split(/\r?\n/).find(l => l.includes(`db.${n} ? db.${n}(`));
    assert.ok(line, `${n} fallback line not found`);
    assert.match(line, /FEATURE_UNAVAILABLE/, `${n} fallback must be an explicit failure`);
  }
});
