'use strict';

/**
 * VAAYU Enterprise & Multi-Tenant Isolation Service
 *
 * Core Mission:
 * Enforces tenant boundary isolation below the controller/UI layer across:
 * 1. Storage & Repository Scoping (Orders, Customers, Drivers, Private Fleets)
 * 2. Enterprise RBAC (MERCHANT_ADMIN, MERCHANT_DISPATCHER, MERCHANT_AUDITOR)
 * 3. Tenant-Scoped Redis Keys & Cache Namespaces
 * 4. Per-Tenant Rate Limiting & Quota Throttling (Noisy Neighbor Isolation)
 * 5. Atomic Batch & Bulk Operation Scoping
 * 6. Tenant Suspension & Fail-Closed Lifecycle Enforcement
 * 7. Dedicated Ledger Sub-Account Derivation (wallet:tenant:{tenantId})
 * 8. Tenant Audit Trails
 */

const { metricsService } = require('./metricsService');
const { logger } = require('./logger');

class TenantIsolationService {
  constructor(options = {}) {
    this.db = options.db || require('../db/database');
    this.redisClient = options.redisClient || null;
    this.tenantConfigs = new Map(); // tenantId -> config object
    this.tenantStatus = new Map();  // tenantId -> 'ACTIVE' | 'SUSPENDED' | 'TERMINATED'
    this.auditLogs = [];            // in-memory tenant audit trail
  }

  /**
   * 14.1 & 14.16 Tenant Status & Suspension Gate
   */
  setTenantStatus(tenantId, status) {
    this.tenantStatus.set(String(tenantId), String(status).toUpperCase());
  }

  getTenantStatus(tenantId) {
    return this.tenantStatus.get(String(tenantId)) || 'ACTIVE';
  }

  assertTenantActive(tenantId) {
    metricsService.increment('tenant_isolation_checks_total');
    const status = this.getTenantStatus(tenantId);
    if (status === 'SUSPENDED' || status === 'TERMINATED') {
      metricsService.increment('tenant_suspended_rejections_total');
      const err = new Error(`Tenant [${tenantId}] is ${status}. Access denied.`);
      err.code = 'TENANT_SUSPENDED';
      err.status = 403;
      throw err;
    }
    return true;
  }

  /**
   * 14.1 & 14.2 Deep Repository Scoping - Trip / Order Scoping
   */
  getScopedTrip(tripId, tenantId) {
    this.assertTenantActive(tenantId);
    const trip = this.db.getTripById(tripId);
    if (!trip) return null;

    const recordTenant = trip.merchantId || trip.merchant_id || trip.tenantId || trip.tenant_id;
    if (recordTenant && String(recordTenant) !== String(tenantId)) {
      metricsService.increment('tenant_cross_access_blocked_total');
      return null; // Strict isolation: Foreign tenant entity appears non-existent (IDOR defense)
    }
    return trip;
  }

  /**
   * 14.2 List Trips strictly scoped to Tenant
   */
  listScopedTrips(tenantId, options = {}) {
    this.assertTenantActive(tenantId);
    const store = this.db.getDb ? this.db.getDb() : {};
    const trips = store.trips || [];
    return trips.filter(t => {
      const recTenant = t.merchantId || t.merchant_id || t.tenantId || t.tenant_id;
      return recTenant && String(recTenant) === String(tenantId);
    });
  }

  /**
   * 14.3 Customer Partitioning
   */
  getScopedCustomer(customerId, tenantId) {
    this.assertTenantActive(tenantId);
    const store = this.db.getDb ? this.db.getDb() : {};
    const users = store.users || [];
    const user = users.find(u => u.id === customerId);
    if (!user) return null;

    const userTenant = user.tenantId || user.merchantId;
    if (userTenant && String(userTenant) !== String(tenantId)) {
      metricsService.increment('tenant_cross_access_blocked_total');
      return null; // Customer belongs to another tenant
    }
    return user;
  }

  /**
   * 14.3 Dedicated / Private Fleet Partitioning
   */
  getScopedFleetDrivers(tenantId) {
    this.assertTenantActive(tenantId);
    const store = this.db.getDb ? this.db.getDb() : {};
    const profiles = store.driver_profiles || [];
    // Dedicated drivers belong strictly to this tenant. Marketplace drivers have null tenantId.
    return profiles.filter(d => {
      const dTenant = d.tenantId || d.merchantId;
      return dTenant && String(dTenant) === String(tenantId);
    });
  }

  /**
   * 14.4 Ledger Sub-Account Derivation
   */
  getTenantLedgerAccountId(tenantId, accountType = 'wallet') {
    if (!tenantId) throw new Error('tenantId is required for ledger sub-account');
    return `${accountType}:tenant:${tenantId}`;
  }

  /**
   * 14.5 Enterprise RBAC Verification
   */
  authorizeTenantRole(user, requiredRole) {
    if (!user) throw new Error('Unauthenticated');
    const userRole = user.role || 'CUSTOMER';
    const userTenantId = user.tenantId || user.merchantId;

    if (userRole === 'ADMIN' || userRole === 'SUPER_ADMIN') {
      return { authorized: true, role: userRole };
    }

    const ROLE_HIERARCHY = {
      'MERCHANT_ADMIN': ['MERCHANT_ADMIN', 'MERCHANT_DISPATCHER', 'MERCHANT_AUDITOR'],
      'MERCHANT': ['MERCHANT_ADMIN', 'MERCHANT_DISPATCHER', 'MERCHANT_AUDITOR'],
      'MERCHANT_DISPATCHER': ['MERCHANT_DISPATCHER'],
      'MERCHANT_AUDITOR': ['MERCHANT_AUDITOR']
    };

    const allowedRoles = ROLE_HIERARCHY[userRole] || [userRole];
    if (!allowedRoles.includes(requiredRole)) {
      metricsService.increment('authorization_denied_total');
      const err = new Error(`Role [${userRole}] does not satisfy required role [${requiredRole}]`);
      err.code = 'FORBIDDEN_ROLE';
      err.status = 403;
      throw err;
    }

    return { authorized: true, role: userRole, tenantId: userTenantId };
  }

  /**
   * 14.7 Tenant-Scoped Redis Key & Cache Namespace Helper
   */
  formatScopedKey(tenantId, keyPath) {
    if (!tenantId) throw new Error('tenantId required for scoped cache key');
    return `tenant:${tenantId}:${keyPath}`;
  }

  /**
   * 14.9 Export & Reporting Filter (Zero byte leakage check)
   */
  generateTenantReport(tenantId, records = []) {
    this.assertTenantActive(tenantId);
    const filtered = records.filter(rec => {
      const recTenant = rec.tenantId || rec.tenant_id || rec.merchantId || rec.merchant_id;
      return recTenant && String(recTenant) === String(tenantId);
    });

    const foreignRecords = records.filter(rec => {
      const recTenant = rec.tenantId || rec.tenant_id || rec.merchantId || rec.merchant_id;
      return recTenant && String(recTenant) !== String(tenantId);
    });

    return {
      tenantId,
      recordCount: filtered.length,
      records: filtered,
      foreignRecordsFilteredOut: foreignRecords.length,
      crossTenantLeakageBytes: 0
    };
  }

  /**
   * 14.11 Enterprise Configuration Scoping
   */
  setTenantConfig(tenantId, config) {
    this.tenantConfigs.set(String(tenantId), {
      ...(this.tenantConfigs.get(String(tenantId)) || {}),
      ...config,
      updatedAt: new Date().toISOString()
    });
  }

  getTenantConfig(tenantId) {
    return this.tenantConfigs.get(String(tenantId)) || {
      commissionRateBps: 1500, // 15% default
      maxConcurrentTrips: 100,
      turnaroundBufferMin: 15,
      whitelistedVehicleTypes: ['2W', '3W', 'TATA_ACE']
    };
  }

  /**
   * 14.12 Per-Tenant Rate Limiting (Noisy Neighbor Isolation)
   */
  async checkTenantQuota(tenantId, rateLimiter, quotaLimit = 10, windowSec = 60) {
    this.assertTenantActive(tenantId);
    metricsService.increment('tenant_isolation_checks_total');

    if (!rateLimiter || !rateLimiter.redis) {
      return { allowed: true, remaining: quotaLimit };
    }

    const redisKey = `tenant:quota:${tenantId}`;
    const current = await rateLimiter.redis.incr(redisKey);
    if (current === 1) {
      await rateLimiter.redis.expire(redisKey, windowSec);
    }

    if (current > quotaLimit) {
      metricsService.increment('tenant_quota_exceeded_total');
      return {
        allowed: false,
        code: 'TENANT_QUOTA_EXCEEDED',
        limit: quotaLimit,
        current,
        remaining: 0
      };
    }

    return {
      allowed: true,
      limit: quotaLimit,
      current,
      remaining: Math.max(0, quotaLimit - current)
    };
  }

  /**
   * 14.13 Tenant Audit Trail
   */
  recordAuditLog(actorId, tenantId, action, resourceId, details = {}) {
    const entry = {
      auditId: `aud_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      actorId,
      tenantId,
      action,
      resourceId,
      details,
      timestamp: new Date().toISOString()
    };
    this.auditLogs.push(entry);
    return entry;
  }

  getScopedAuditLogs(tenantId) {
    return this.auditLogs.filter(log => String(log.tenantId) === String(tenantId));
  }

  /**
   * 14.14 Atomic Batch / Bulk Operation Scoping
   */
  processBulkOrders(tenantId, batchItems = []) {
    this.assertTenantActive(tenantId);
    metricsService.increment('tenant_bulk_operations_total');

    const accepted = [];
    const rejectedForeign = [];

    for (const item of batchItems) {
      const itemTenant = item.tenantId || item.merchantId;
      if (itemTenant && String(itemTenant) !== String(tenantId)) {
        metricsService.increment('tenant_cross_access_blocked_total');
        rejectedForeign.push({
          itemId: item.id,
          reason: 'POISONED_CROSS_TENANT_ITEM',
          itemTenant
        });
      } else {
        accepted.push({
          ...item,
          tenantId,
          merchantId: tenantId,
          status: 'ACCEPTED'
        });
      }
    }

    return {
      tenantId,
      totalReceived: batchItems.length,
      acceptedCount: accepted.length,
      rejectedCount: rejectedForeign.length,
      acceptedItems: accepted,
      rejectedForeign
    };
  }
}

const tenantIsolationService = new TenantIsolationService();

module.exports = {
  TenantIsolationService,
  tenantIsolationService
};
