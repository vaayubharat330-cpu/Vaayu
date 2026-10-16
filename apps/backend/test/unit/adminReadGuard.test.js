'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { authorizeAdminRead, getRequiredAdminRoles } = require('../../src/http/adminReadGuard');

const SECRET = 'vaayu-admin-read-test-secret-1234567890';
const authService = {
  verifyToken(token) {
    try { return jwt.verify(token, SECRET); } catch (_) { return null; }
  }
};

function token(user) {
  return jwt.sign(user, SECRET, { algorithm: 'HS256', expiresIn: '10m' });
}

test('admin read guard protects sensitive admin reads', () => {
  assert.deepEqual([...getRequiredAdminRoles('/api/admin/settings')].sort(), ['ADMIN', 'SUPER_ADMIN']);
  assert.deepEqual([...getRequiredAdminRoles('/api/admin/support/tickets')].sort(), ['ADMIN', 'SUPER_ADMIN', 'SUPPORT_AGENT']);
  assert.equal(getRequiredAdminRoles('/api/admin/unknown'), null);
});

test('admin read guard rejects missing and invalid credentials', () => {
  assert.equal(authorizeAdminRead({ pathname: '/api/admin/settings', method: 'GET', token: '', authService }).allowed, false);
  assert.equal(authorizeAdminRead({ pathname: '/api/admin/settings', method: 'GET', token: 'not-a-token', authService }).allowed, false);
});

test('admin read guard enforces least-privilege roles', () => {
  const customerToken = token({ id: 'customer-1', role: 'CUSTOMER' });
  const supportToken = token({ id: 'support-1', role: 'SUPPORT_AGENT' });
  const adminToken = token({ id: 'admin-1', role: 'ADMIN' });

  assert.equal(authorizeAdminRead({ pathname: '/api/admin/settings', method: 'GET', token: customerToken, authService }).allowed, false);
  assert.equal(authorizeAdminRead({ pathname: '/api/admin/settings', method: 'GET', token: supportToken, authService }).allowed, false);
  assert.equal(authorizeAdminRead({ pathname: '/api/admin/settings', method: 'GET', token: adminToken, authService }).allowed, true);
  assert.equal(authorizeAdminRead({ pathname: '/api/admin/support/tickets', method: 'GET', token: supportToken, authService }).allowed, true);
});

test('admin read guard does not alter unrelated routes or non-GET requests', () => {
  assert.equal(authorizeAdminRead({ pathname: '/api/admin/settings/update', method: 'POST', token: '', authService }).allowed, true);
  assert.equal(authorizeAdminRead({ pathname: '/api/customer/profile', method: 'GET', token: '', authService }).required, false);
});
