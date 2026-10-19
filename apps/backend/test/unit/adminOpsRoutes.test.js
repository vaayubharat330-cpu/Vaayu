'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminOpsRoutes } = require('../../src/http/adminOpsRoutes');

test('healthy driver telemetry contributes to online fleet totals and filters', async () => {
  const drivers = [
    { id: 'driver-healthy', name: 'Healthy Driver', status: 'ONLINE' },
    { id: 'driver-degraded', name: 'Degraded Driver', status: 'ONLINE' },
    { id: 'driver-offline', name: 'Offline Driver', status: 'OFFLINE' },
    { id: 'driver-recently-offline', name: 'Recently Offline Driver', status: 'OFFLINE' }
  ];
  const telemetry = {
    'driver-healthy': { status: 'ONLINE', livenessState: 'HEALTHY', lastPingMs: Date.now(), lat: 17.4, lng: 78.4 },
    'driver-degraded': { status: 'ONLINE', livenessState: 'DEGRADED', lastPingMs: Date.now(), lat: 17.4, lng: 78.4 },
    'driver-offline': null,
    'driver-recently-offline': { status: 'OFFLINE', livenessState: 'HEALTHY', lastPingMs: Date.now(), lat: 17.4, lng: 78.4 }
  };
  const handle = createAdminOpsRoutes({
    db: { getDrivers: () => drivers },
    driverLocationService: { getDriverState: async id => telemetry[id] },
    redisLockManager: { getDriverLock: async () => null },
    enforceSecurityChecks: async () => true
  });

  async function request(status) {
    let body;
    const response = {
      writeHead(code) { this.statusCode = code; },
      end(value) { body = JSON.parse(value); }
    };
    await handle({ method: 'GET' }, response, {
      pathname: '/api/admin/fleet/live',
      parsedUrl: { query: status ? { status } : {} }
    });
    return { statusCode: response.statusCode, body };
  }

  const allDrivers = await request();
  assert.equal(allDrivers.statusCode, 200);
  assert.equal(allDrivers.body.summary.onlineCount, 1);
  assert.equal(allDrivers.body.summary.degradedCount, 1);
  assert.equal(allDrivers.body.summary.offlineCount, 2);
  assert.equal(allDrivers.body.summary.utilizationPercent, 50);

  const onlineDrivers = await request('ONLINE');
  assert.ok(onlineDrivers.body.drivers.some(driver => driver.driverId === 'driver-healthy'));
  assert.ok(!onlineDrivers.body.drivers.some(driver => driver.driverId === 'driver-recently-offline'));
});
