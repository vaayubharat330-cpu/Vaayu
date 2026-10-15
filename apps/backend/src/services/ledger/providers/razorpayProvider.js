'use strict';

const crypto = require('crypto');
const { BasePaymentProvider } = require('./basePaymentProvider');

/**
 * VAAYU RAZORPAY PAYMENT ADAPTER (Phase F.4)
 * 
 * Implements BasePaymentProvider with timing-safe signature verification,
 * integer-paise normalization, and webhook normalization.
 */
class RazorpayProvider extends BasePaymentProvider {
  constructor({
    keyId = process.env.RAZORPAY_KEY_ID,
    keySecret = process.env.RAZORPAY_KEY_SECRET,
    webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET,
    fetchImpl = global.fetch
  } = {}) {
    super('razorpay');
    this.keyId = keyId;
    this.keySecret = keySecret;
    this.webhookSecret = webhookSecret;
    this.fetch = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.keyId && this.keySecret);
  }

  async _request(endpoint, { method = 'GET', body, headers = {} } = {}) {
    if (!this.isConfigured()) {
      throw new Error('Razorpay is not configured. RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required.');
    }
    const authHeader = `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
    const res = await this.fetch(`https://api.razorpay.com/v1/${endpoint}`, {
      method,
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.description || `Razorpay request failed with HTTP ${res.status}`);
      err.status = res.status;
      err.details = data;
      throw err;
    }
    return data;
  }

  async createPaymentOrder({ amountPaise, currency = 'INR', receipt, notes = {} }) {
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      throw new Error('amountPaise must be a positive integer in paise.');
    }

    const res = await this._request('orders', {
      method: 'POST',
      body: {
        amount: amountPaise,
        currency,
        receipt: String(receipt || `vaayu_${Date.now()}`).slice(0, 40),
        notes
      }
    });

    return {
      providerOrderId: res.id,
      amountPaise: Number(res.amount),
      currency: res.currency,
      status: res.status,
      raw: res
    };
  }

  async fetchPayment(providerPaymentId) {
    if (!providerPaymentId) throw new Error('providerPaymentId is required.');
    const res = await this._request(`payments/${encodeURIComponent(providerPaymentId)}`);
    return {
      providerPaymentId: res.id,
      providerOrderId: res.order_id,
      status: res.status,
      amountPaise: Number(res.amount),
      currency: res.currency,
      isCaptured: res.status === 'captured',
      raw: res
    };
  }

  verifyWebhookSignature(rawPayload, signature, secret = this.webhookSecret) {
    if (!secret || !signature || !rawPayload) return false;
    const bodyStr = typeof rawPayload === 'string' ? rawPayload : rawPayload.toString('utf8');
    const expected = crypto.createHmac('sha256', secret).update(bodyStr).digest();
    let provided;
    try {
      provided = Buffer.from(String(signature).trim(), 'hex');
    } catch (_) {
      return false;
    }
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  }

  normalizeWebhook(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Malformed webhook payload: Expected JSON object.');
    }

    const eventType = payload.event;
    const providerEventId = payload.event_id || payload.id || `evt_${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;

    // Extract payment or refund entity
    const paymentEntity = payload.payload?.payment?.entity;
    const refundEntity = payload.payload?.refund?.entity;
    const orderEntity = payload.payload?.order?.entity;

    const providerPaymentId = paymentEntity?.id || refundEntity?.payment_id || null;
    const providerOrderId = paymentEntity?.order_id || orderEntity?.id || null;
    const amountPaise = paymentEntity?.amount !== undefined ? Number(paymentEntity.amount) : (refundEntity?.amount !== undefined ? Number(refundEntity.amount) : null);
    const currency = paymentEntity?.currency || refundEntity?.currency || 'INR';
    const status = paymentEntity?.status || refundEntity?.status || 'unknown';

    return {
      provider: 'razorpay',
      providerEventId,
      eventType,
      providerPaymentId,
      providerOrderId,
      amountPaise,
      currency,
      status,
      isCaptured: eventType === 'payment.captured' || status === 'captured',
      isRefunded: eventType === 'refund.processed' || status === 'refunded',
      refundId: refundEntity?.id || null,
      notes: paymentEntity?.notes || orderEntity?.notes || {},
      raw: payload
    };
  }

  async refundPayment({ providerPaymentId, amountPaise, reason = 'Customer cancellation' }) {
    if (!providerPaymentId) throw new Error('providerPaymentId is required for refund.');
    const body = {
      notes: { reason: String(reason).slice(0, 200) }
    };
    if (amountPaise !== undefined && amountPaise !== null) {
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
        throw new Error('Refund amountPaise must be a positive integer.');
      }
      body.amount = amountPaise;
    }

    const res = await this._request(`payments/${encodeURIComponent(providerPaymentId)}/refund`, {
      method: 'POST',
      body
    });

    return {
      refundId: res.id,
      providerPaymentId: res.payment_id,
      amountPaise: Number(res.amount),
      status: res.status,
      raw: res
    };
  }
}

module.exports = {
  RazorpayProvider
};
