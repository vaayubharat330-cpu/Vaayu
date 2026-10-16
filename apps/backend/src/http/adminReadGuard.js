'use strict';

const PROTECTED_ADMIN_READ_ROUTES = new Map([
  ['/api/admin/settings', new Set(['ADMIN', 'SUPER_ADMIN'])],
  ['/api/admin/support/tickets', new Set(['ADMIN', 'SUPER_ADMIN', 'SUPPORT_AGENT'])],
  ['/api/admin/automations/logs', new Set(['ADMIN', 'SUPER_ADMIN'])]
]);

function normalizePathname(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return '/';
  let normalized = pathname;
  try {
    normalized = decodeURIComponent(normalized);
  } catch (_) {
    return null;
  }
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  return normalized || '/';
}

function getRequiredAdminRoles(pathname) {
  const normalized = normalizePathname(pathname);
  if (!normalized) return null;
  return PROTECTED_ADMIN_READ_ROUTES.get(normalized) || null;
}

function authorizeAdminRead({ pathname, method, token, authService }) {
  if (method !== 'GET') return { required: false, allowed: true };
  const roles = getRequiredAdminRoles(pathname);
  if (!roles) return { required: false, allowed: true };
  if (!token) return { required: true, allowed: false, code: 'AUTHENTICATION_REQUIRED' };
  let user = null;
  try { user = authService.verifyToken(token); } catch (_) { user = null; }
  if (!user) return { required: true, allowed: false, code: 'INVALID_TOKEN' };
  if (!roles.has(user.role)) return { required: true, allowed: false, code: 'FORBIDDEN_ROLE' };
  return { required: true, allowed: true, user };
}

module.exports = { PROTECTED_ADMIN_READ_ROUTES, normalizePathname, getRequiredAdminRoles, authorizeAdminRead };
