const crypto = require('crypto');

/** Razorpay adapter. Never reports success unless the remote API/signature did. */
class PaymentProvider {
  constructor({ fetchImpl = global.fetch } = {}) {
    this.fetch = fetchImpl;
    this.providerName = 'razorpay';
  }

  get credentials() {
    return { keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET };
  }

  get configured() {
    return Boolean(this.credentials.keyId && this.credentials.keySecret);
  }

  async processPayment(orderId, amount, paymentMethod = 'CASH_ON_DELIVERY') {
    const normalizedMethod = String(paymentMethod || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    const isCash = ['CASH', 'COD', 'CASH_ON_DELIVERY'].includes(normalizedMethod);
    return {
      success: isCash,
      provider: isCash ? 'CASH_ON_DELIVERY' : this.providerName,
      status: isCash ? 'PAYMENT_DUE_ON_DELIVERY' : 'PAYMENT_REQUIRED',
      requiresPayment: !isCash,
      isPaid: false,
      deferred: !isCash,
      orderId,
      amount: Number(amount) || 0,
      paymentMethod,
      timestamp: new Date().toISOString(),
      notes: isCash ? 'Payment is due in cash at delivery; no gateway charge has occurred.' : 'No payment was collected. Create a gateway order and verify its signature before marking this booking paid.'
    };
  }

  async request(endpoint, { method = 'GET', body, headers: extraHeaders = {} } = {}) {
    if (!this.configured) throw new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    const { keyId, keySecret } = this.credentials;
    const response = await this.fetch(`https://api.razorpay.com/v1/${endpoint}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
        ...extraHeaders
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result?.error?.description || `Razorpay returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async createOrder({ amount, currency = 'INR', receipt, notes = {} }) {
    const rupees = Number(amount);
    if (!Number.isFinite(rupees) || rupees <= 0 || rupees > 10000000) throw new Error('Payment amount must be between 0 and 10,000,000 INR.');
    const order = await this.request('orders', {
      method: 'POST',
      body: { amount: Math.round(rupees * 100), currency, receipt: String(receipt || `vaayu_${Date.now()}`).slice(0, 40), notes }
    });
    return { success: true, configured: true, provider: this.providerName, order_id: order.id, amount: order.amount, currency: order.currency, key_id: this.credentials.keyId, status: order.status };
  }

  verifySignature(orderId, paymentId, signature) {
    const { keySecret } = this.credentials;
    if (!keySecret || !orderId || !paymentId || !signature) return false;
    const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest();
    let provided;
    try { provided = Buffer.from(String(signature), 'hex'); } catch (_) { return false; }
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  }

  async getPaymentStatus(paymentId) {
    const payment = await this.request(`payments/${encodeURIComponent(paymentId)}`);
    return { success: true, provider: this.providerName, paymentId: payment.id, orderId: payment.order_id, status: payment.status, amount: payment.amount, currency: payment.currency, isPaid: payment.status === 'captured' };
  }

  async refundPayment(paymentId, amount, reason = 'Customer cancellation') {
    if (!paymentId) throw new Error('A captured Razorpay payment ID is required to refund.');
    const body = {};
    if (amount !== undefined && amount !== null) {
      const rupees = Number(amount);
      if (!Number.isFinite(rupees) || rupees <= 0) throw new Error('Refund amount must be greater than zero.');
      body.amount = Math.round(rupees * 100);
    }
    body.notes = { reason: String(reason).slice(0, 200) };
    const refund = await this.request(`payments/${encodeURIComponent(paymentId)}/refund`, { method: 'POST', body });
    return { success: true, provider: this.providerName, refundIssued: true, refundId: refund.id, status: refund.status, amount: refund.amount / 100, paymentId: refund.payment_id };
  }

  async createUpiPayout({ amount, upiId, name, phone, referenceId, idempotencyKey }) {
    if (process.env.VAAYU_ENABLE_RAZORPAYX_PAYOUTS !== 'true') throw new Error('RazorpayX payouts are disabled. Set VAAYU_ENABLE_RAZORPAYX_PAYOUTS=true after reviewing transfer controls.');
    const accountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER;
    if (!accountNumber) throw new Error('RAZORPAYX_ACCOUNT_NUMBER is required for payouts.');
    const rupees = Number(amount);
    if (!Number.isFinite(rupees) || rupees < 1 || rupees > 10000) throw new Error('Payout amount must be between ₹1 and ₹10,000 per transfer.');
    if (!/^[\w.-]{2,256}@[\w.-]{2,64}$/.test(String(upiId || ''))) throw new Error('A valid UPI ID is required.');
    const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
    if (cleanPhone.length !== 10) throw new Error('A valid 10-digit recipient phone number is required.');
    const result = await this.request('payouts', {
      method: 'POST',
      headers: { 'X-Payout-Idempotency': idempotencyKey },
      body: {
        account_number: accountNumber,
        amount: Math.round(rupees * 100),
        currency: 'INR',
        mode: 'UPI',
        purpose: 'payout',
        queue_if_low_balance: false,
        reference_id: String(referenceId).slice(0, 40),
        fund_account: {
          account_type: 'vpa',
          vpa: { address: String(upiId) },
          contact: { name: String(name || 'VAAYU Driver').slice(0, 100), contact: cleanPhone, type: 'employee', reference_id: String(referenceId).slice(0, 40) }
        }
      }
    });
    return { success: true, provider: 'razorpayx', payoutId: result.id, status: result.status, utr: result.utr || null, amount: result.amount / 100, referenceId: result.reference_id };
  }
}

const paymentProvider = new PaymentProvider();
module.exports = { PaymentProvider, paymentProvider };
