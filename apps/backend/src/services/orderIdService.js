/**
 * VAAYU Enterprise Logistics Platform
 * Order ID & Internal Value Generator Service
 *
 * Provides structured, human-readable, and machine-indexed Order IDs
 * across all multi-portal channels (B2B Merchant, Customer App, Control Tower, Driver App).
 */

const crypto = require('crypto');

class OrderIdService {
  /**
   * Supported Portal Identifiers
   */
  static PORTAL_CODES = {
    MERCHANT_PORTAL: 'B2B',
    CUSTOMER_APP: 'CUST',
    CONTROL_TOWER: 'ADM',
    DRIVER_APP: 'DRV',
    API_PARTNER: 'EXT'
  };

  /**
   * Order Category Identifiers
   */
  static CATEGORY_CODES = {
    EXPRESS: 'EXP',
    BULK_BATCH: 'BLK',
    RECURRING: 'REC',
    EMERGENCY: 'RED', // Re-dispatch
    SCHEDULED: 'SCH'
  };

  /**
   * Generate a structured Enterprise Order ID
   * @param {Object} options 
   * @param {string} options.portal - MERCHANT_PORTAL | CUSTOMER_APP | CONTROL_TOWER | DRIVER_APP
   * @param {string} options.category - EXPRESS | BULK_BATCH | RECURRING | EMERGENCY | SCHEDULED
   * @param {string} options.region - Optional city/zone code (e.g. HYD, BLR, BOM)
   * @returns {string} e.g. "ORD-B2B-EXP-20261005-7F3A9"
   */
  generateOrderId(options = {}) {
    const portal = options.portal || 'CUSTOMER_APP';
    const category = options.category || 'EXPRESS';
    const region = (options.region || 'HYD').toUpperCase().substring(0, 3);

    const pCode = OrderIdService.PORTAL_CODES[portal] || 'CUST';
    const cCode = OrderIdService.CATEGORY_CODES[category] || 'EXP';

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}${mm}${dd}`;

    const randomHash = crypto.randomBytes(3).toString('hex').toUpperCase();

    return `ORD-${pCode}-${cCode}-${region}-${dateStr}-${randomHash}`;
  }

  /**
   * Parse an order ID into structured metadata components
   * Supports both new "ORD-..." IDs and legacy "TRIP_..." IDs.
   * @param {string} orderId 
   * @returns {Object}
   */
  parseOrderId(orderId) {
    if (!orderId || typeof orderId !== 'string') {
      return { isValid: false, raw: orderId, type: 'UNKNOWN' };
    }

    if (orderId.startsWith('ORD-')) {
      const parts = orderId.split('-');
      if (parts.length >= 6) {
        const [, pCode, cCode, region, dateStr, hash] = parts;
        return {
          isValid: true,
          type: 'ENTERPRISE_STRUCTURED',
          raw: orderId,
          portalCode: pCode,
          categoryCode: cCode,
          region,
          dateStr,
          hash,
          isB2B: pCode === 'B2B',
          isEmergency: cCode === 'RED'
        };
      }
    }

    // Legacy or generic fallback format (e.g. TRIP_1791196697129)
    return {
      isValid: true,
      type: 'LEGACY_TIMESTAMP',
      raw: orderId,
      portalCode: 'CUST',
      categoryCode: 'EXP',
      region: 'HYD',
      dateStr: null,
      hash: orderId.replace('TRIP_', ''),
      isB2B: false,
      isEmergency: false
    };
  }

  /**
   * Attach internal system values to an order object for efficient calling & indexing
   * @param {Object} order 
   * @param {Object} context 
   * @returns {Object} enriched internal values object
   */
  attachInternalValues(order, context = {}) {
    if (!order) return null;

    const parsed = this.parseOrderId(order.id);
    const internalValues = {
      internalRefId: `REF_${parsed.hash || Date.now()}`,
      sourcePortal: context.portalId || (parsed.isB2B ? 'MERCHANT_PORTAL' : 'CUSTOMER_APP'),
      channel: context.channel || 'WEB_PORTAL',
      category: parsed.categoryCode || 'EXP',
      regionCode: parsed.region || 'HYD',
      isEnterpriseOrder: parsed.isB2B || order.isB2B || false,
      createdTimestamp: order.createdAt || new Date().toISOString(),
      routingEngineVersion: 'v1.4.0-prod'
    };

    order.internalValues = internalValues;
    return internalValues;
  }
}

const orderIdService = new OrderIdService();

module.exports = {
  OrderIdService,
  orderIdService
};
