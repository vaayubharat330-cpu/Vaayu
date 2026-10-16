'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const routePath = path.resolve(__dirname, '../../src/http/proofRoutes.js');
const source = fs.readFileSync(routePath, 'utf8');

test('camera POST route is wired through the frame gateway', () => {
  assert.match(source, /require\('\.\.\/services\/cameraFrameGateway'\)/);
  assert.match(source, /cameraFrameGateway\.accept\(/);
  assert.match(source, /latestFrameSha256/);
  assert.match(source, /X-Frame-SHA256/);
});

test('camera session records the authenticated driver identity', () => {
  assert.match(source, /driverUserId: driver\?\.userId \|\| req\.user\.id/);
  assert.match(source, /lastCapturedAtMs: 0/);
});
