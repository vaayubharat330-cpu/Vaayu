'use strict';

/**
 * VAAYU PAYMENT PROVIDER ADAPTER BASE INTERFACE (Phase F.4)
 * 
 * Strict pluggable abstraction decoupling external payment rails (Razorpay, Cashfree, UPI, COD)
 * from the internal VAAYU double-entry ledger and payment state machine.
 */
class BasePaymentProvider {
  constructor(name) {
    if (!name) throw new Error('Payment provider name is required.');
    this.name = name;
  }

  /**
   * Return whether provider credentials / network configuration are ready.
   * @returns {boolean}
   */
  isConfigured() {
    throw new Error('isConfigured() must be implemented by provider adapter.');
  }

  /**
   * Create an intent / payment order on the external provider.
   * @param {Object} params
   * @param {number} params.amountPaise
   * @param {string} params.currency
   * @param {string} params.receipt
   * @param {Object} params.notes
   * @returns {Promise<{ providerOrderId: string, amountPaise: number, currency: string, raw: Object }>}
   */
  async createPaymentOrder({ amountPaise, currency = 'INR', receipt, notes = {} }) {
    throw new Error('createPaymentOrder() must be implemented by provider adapter.');
  }

  /**
   * Fetch payment status directly from the remote provider API.
   * @param {string} providerPaymentId
   * @returns {Promise<{ providerPaymentId: string, providerOrderId: string, status: string, amountPaise: number, currency: string, isCaptured: boolean, raw: Object }>}
   */
  async fetchPayment(providerPaymentId) {
    throw new Error('fetchPayment() must be implemented by provider adapter.');
  }

  /**
   * Cryptographically verify an incoming webhook request signature.
   * @param {string|Buffer} rawPayload - Exact unparsed incoming body string/buffer
   * @param {string} signature - Signature header from provider
   * @param {string} secret - Webhook secret key
   * @returns {boolean}
   */
  verifyWebhookSignature(rawPayload, signature, secret) {
    throw new Error('verifyWebhookSignature() must be implemented by provider adapter.');
  }

  /**
   * Parse & normalize an incoming provider webhook payload into VAAYU domain structure.
   * @param {Object} payload - Parsed JSON webhook payload
   * @returns {{
   *   providerEventId: string,
   *   eventType: string,
   *   providerPaymentId: string,
   *   providerOrderId: string,
   *   amountPaise: number,
   *   currency: string,
   *   status: string,
   *   isCaptured: boolean,
   *   isRefunded: boolean,
   *   refundId: string|null,
   *   raw: Object
   * }}
   */
  normalizeWebhook(payload) {
    throw new Error('normalizeWebhook() must be implemented by provider adapter.');
  }

  /**
   * Execute an external refund on the provider rail.
   * @param {Object} params
   * @param {string} params.providerPaymentId
   * @param {number} params.amountPaise
   * @param {string} params.reason
   * @returns {Promise<{ refundId: string, amountPaise: number, status: string, raw: Object }>}
   */
  async refundPayment({ providerPaymentId, amountPaise, reason }) {
    throw new Error('refundPayment() must be implemented by provider adapter.');
  }
}

module.exports = {
  BasePaymentProvider
};
