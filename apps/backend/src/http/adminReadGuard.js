'use strict';

const PROTECTED_ADMIN_READ_ROUTES = new Map([
  ['/api/admin/settings', new Set(['ADMIN', 'SUPER_ADMIN'])],
  ['/api/admin/support/tickets', new Set(['ADMIN', 'SUPER_ADMIN', 'SUPPORT_AGENT'])],
  ['/api/admin/automations/logs', new Set(['ADMIN', 'SUPER_ADMIN'])]
]);

function getRequiredAdminRoles(pathname) {
  return PROTECTED_ADMIN_READ_ROUTES.get(pathname) || null;
}

function authorizeAdminRead({ pathname, method, token, authService }) {
  if (method !== 'GET') return { required: false, allowed: true };
  const roles = getRequiredAdminRoles(pathname);
  if (!roles) return { required: false, allowed: true };
  if (!token) return { required: true, allowed: false, code: 'AUTHENTICATION_REQUIRED' };
  const user = authService.verifyToken(token);
  if (!user) return { required: true, allowed: false, code: 'INVALID_TOKEN' };
  if (!roles.has(user.role)) return { required: true, allowed: false, code: 'FORBIDDEN_ROLE' };
  return { required: true, allowed: true, user };
}

module.exports = { PROTECTED_ADMIN_READ_ROUTES, getRequiredAdminRoles, authorizeAdminRead };
