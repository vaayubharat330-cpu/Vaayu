// Payment gateway routes: create order, verify a captured payment, and payment history. Branch logic is moved from
// server_production.js unchanged. The gateway is off, so create-order and verify refuse until it is configured.
// Each matched route answers and returns true at once, so the router stops here.

function createPaymentRoutes({ db, paymentProvider, enforceSecurityChecks, parseJsonBody, validateFields }) {
  return async function handlePaymentRoute(req, res, { pathname, parsedUrl }) {
    if (pathname === '/api/payment/create-order' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'], targetOrderId: data.bookingId || null })) return;
        if (!validateFields(res, [
          [Number.isFinite(Number(data.amount)) && Number(data.amount) > 0 && Number(data.amount) <= 1000000, 'amount must be a positive number up to 10,00,000'],
          [data.currency === undefined || data.currency === 'INR', 'currency must be INR'],
        ])) return;
        try {
          const externalOrder = await paymentProvider.createOrder({ amount: data.amount, currency: data.currency || 'INR', receipt: data.bookingId || `${req.user.id}_${Date.now()}`, notes: { userId: String(req.user.id), purpose: String(data.purpose || 'TRIP_FARE') } });
          const order = db.createPaymentOrder ? db.createPaymentOrder(req.user.id, Number(data.amount), data.purpose, data.bookingId, externalOrder) : { success: false, error: 'Payment persistence is unavailable.' };
          res.writeHead(order.success ? 201 : 500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(order));
        } catch (error) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: error.message, providerConfigured: paymentProvider.configured }));
        }
      });
      return true;
    }

    if (pathname === '/api/payment/verify-signature' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'] })) return;
        const orderId = data.order_id || data.razorpay_order_id;
        const paymentId = data.payment_id || data.razorpay_payment_id;
        const signature = data.signature || data.razorpay_signature;
        const signatureValid = paymentProvider.verifySignature(orderId, paymentId, signature);
        if (!signatureValid) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid payment signature or payment provider is not configured.' })); }
        const transaction = db.getPaymentByOrder ? db.getPaymentByOrder(orderId) : null;
        if (!transaction || (req.user.role === 'CUSTOMER' && transaction.userId !== req.user.id)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Payment order not found for this account.' }));
        }
        let remotePayment;
        try { remotePayment = await paymentProvider.getPaymentStatus(paymentId); }
        catch (error) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Could not confirm payment with Razorpay: ${error.message}` }));
        }
        if (!remotePayment.isPaid || remotePayment.orderId !== orderId || remotePayment.amount !== Math.round(Number(transaction.amount) * 100) || remotePayment.currency !== transaction.currency) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Razorpay payment is not captured or does not match the order amount/currency.', providerStatus: remotePayment.status }));
        }
        const verified = db.verifyPaymentSignature ? db.verifyPaymentSignature(orderId, paymentId, signature, true) : { success: false, error: 'Payment persistence is unavailable.' };
        res.writeHead(verified.success ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(verified));
      });
      return true;
    }

    if (pathname === '/api/payment/history' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'] })) return true;
      const userId = req.user.role === 'CUSTOMER' ? req.user.id : (parsedUrl.query.user_id || req.user.id);
      const history = db.getPaymentHistory ? db.getPaymentHistory(userId) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, transactions: history }));
      return true;
    }

    return false;
  };
}

module.exports = { createPaymentRoutes };
