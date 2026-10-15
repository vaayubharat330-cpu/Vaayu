// Merchant (B2B) registration, batch booking, CSV import, schedules, orders, savings, export, and SLA routes. Branch
// logic is moved from server_production.js. Registration no longer fabricates a merchant when the store is missing: it
// refuses with FEATURE_UNAVAILABLE. Access to /api/merchant/* is checked by the dispatcher before these run.
// Each matched route answers and returns true at once, so the router stops here.
const { csvCell, isLatitude, isLongitude } = require('./helpers');

function createMerchantBatchRoutes({ db, authService, fareQuoteProvider, dispatchService, slaService, idempotencyService, metricsService, parseJsonBody, validateFields }) {
  return async function handleMerchantBatchRoute(req, res, { pathname, parsedUrl }) {
    if (pathname === '/api/merchant/register' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        const tokenPhone = String(req.user.phone || '').replace(/\D/g, '').slice(-10);
        const inputPhone = String(data.phone || '').replace(/\D/g, '').slice(-10);
        if (req.user.role === 'CUSTOMER' && (!tokenPhone || tokenPhone !== inputPhone)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Business registration phone must match the verified account.' }));
        }
        if (!db.createMerchant) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: { code: 'FEATURE_UNAVAILABLE', message: 'Merchant registration is not available on this server.' } }));
        }
        const merchant = db.createMerchant({ ...data, phone: req.user.role === 'CUSTOMER' ? req.user.phone : data.phone });
        const merchantUser = { id: merchant.id, phone: merchant.phone, name: merchant.contactName || merchant.businessName, role: 'MERCHANT' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, merchant, token: authService.generateToken(merchantUser) }));
      });
      return true;
    }

    if (pathname === '/api/merchant/batch-booking' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;

        // Batch booking is a financial/dispatch command: callers may retry after a network
        // timeout, so accept the same idempotency contract as customer trip creation.
        const effKey = data.idempotencyKey || (req.headers ? req.headers['x-idempotency-key'] : null);
        if (effKey && idempotencyService) {
          const existing = await idempotencyService.findExistingResponse(effKey);
          if (existing.found) {
            res.writeHead(existing.statusCode, { 'Content-Type': 'application/json' });
            return res.end(typeof existing.body === 'string' ? existing.body : JSON.stringify(existing.body));
          }
        } else if (metricsService) {
          metricsService.increment('merchant_batch_booking_without_idempotency_key_total');
        }

        // Every delivery needs real pickup and drop coordinates. A booking is never placed at a default location.
        const hasCoordinates = b => [b.pickupLat, b.dropLat].every(v => typeof v === 'number' && isLatitude(v)) && [b.pickupLng, b.dropLng].every(v => typeof v === 'number' && isLongitude(v));
        if (!Array.isArray(data.bookings) || data.bookings.length === 0 || !data.bookings.every(hasCoordinates)) {
          if (effKey && idempotencyService) await idempotencyService.abortResponse(effKey);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Every booking needs pickup and drop coordinates. Geocode each address before booking.' }));
        }
        let resData;
        try {
          const bookings = await Promise.all((data.bookings || []).map(async booking => {
            const pickupLat = Number(booking.pickupLat);
            const pickupLng = Number(booking.pickupLng);
            const dropLat = Number(booking.dropLat);
            const dropLng = Number(booking.dropLng);
            const helperCount = Math.max(0, Math.min(4, parseInt(booking.helperCount || 0, 10) || 0));
            const quote = await fareQuoteProvider.getFareQuote(pickupLat, pickupLng, dropLat, dropLng, { vehicleId: booking.vehicleId || 'v_ace', helperCount });
            if (!quote.success || !quote.selectedEstimate || quote.selectedEstimate.vehicleId !== (booking.vehicleId || 'v_ace')) {
              throw new Error(quote.error || `A current fare quote is unavailable for ${booking.vehicleName || booking.vehicleId || 'the selected vehicle'}.`);
            }
            return {
              ...booking,
              pickupLat, pickupLng, dropLat, dropLng,
              helperCount,
              fare: quote.selectedEstimate.totalFare,
              fareBreakdown: quote.selectedEstimate.fareBreakdown,
              distanceKm: quote.distanceKm,
              durationMin: quote.durationMin,
              businessOrderId: booking.businessOrderId || data.businessOrderId,
              poReference: booking.poReference || data.poReference,
              requiredSlaTime: booking.requiredSlaTime || data.requiredSlaTime
            };
          }));
          resData = db.createBatchBookings ? db.createBatchBookings(req.authorizedMerchantId || data.merchant_id || data.merchantId, bookings) : { success: false, error: 'Batch booking service is unavailable.' };
        } catch (error) {
          resData = { success: false, error: error.message || 'Batch booking could not be created.' };
        }
        if (resData.success) {
          resData.dispatch = await Promise.all((resData.trips || []).map(async trip => {
            try { return await dispatchService.findAndOfferDriver(trip.id); }
            catch (error) { return { success: false, orderId: trip.id, error: error.message || 'Dispatch could not start.' }; }
          }));
        } else if (effKey && idempotencyService) {
          await idempotencyService.abortResponse(effKey);
        }

        const responsePayload = resData;
        if (resData.success && effKey && idempotencyService) {
          await idempotencyService.saveResponse(effKey, resData.trips?.[0]?.id || null, 200, responsePayload);
        }

        res.writeHead(resData.success ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(responsePayload));
      });
      return true;
    }

    if (pathname === '/api/merchant/parse-csv' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        const csvContent = data.csvContent || data.rows || body;
        if (!validateFields(res, [
          [typeof csvContent === 'string' && csvContent.length <= 200000, 'csvContent must be text up to 200 KB'],
        ])) return;
        const resData = db.parseCsvOrders ? db.parseCsvOrders(csvContent) : { success: false, error: { code: 'FEATURE_UNAVAILABLE', message: 'CSV import is not available on this server.' } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resData));
      });
      return true;
    }

    if (pathname === '/api/merchant/schedules' && req.method === 'GET') {
      const merchantId = req.authorizedMerchantId || parsedUrl.query.merchant_id || parsedUrl.query.merchantId;
      const schedules = db.getMerchantSchedules ? db.getMerchantSchedules(merchantId) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, schedules }));
      return true;
    }

    if (pathname === '/api/merchant/schedules' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        const resData = db.createSchedule ? db.createSchedule(req.authorizedMerchantId || data.merchant_id || data.merchantId, data) : { success: false, error: { code: 'FEATURE_UNAVAILABLE', message: 'This feature is not available on this server.' } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resData));
      });
      return true;
    }

    if (pathname === '/api/merchant/schedules/cancel' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!validateFields(res, [
          [typeof (data.schedule_id || data.scheduleId) === 'string' && (data.schedule_id || data.scheduleId).length >= 1 && (data.schedule_id || data.scheduleId).length <= 128, 'schedule_id is required, up to 128 characters'],
        ])) return;
        const resData = db.cancelSchedule ? db.cancelSchedule(req.authorizedMerchantId || data.merchant_id || data.merchantId, data.schedule_id || data.scheduleId) : { success: false, error: { code: 'FEATURE_UNAVAILABLE', message: 'This feature is not available on this server.' } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resData));
      });
      return true;
    }

    if (pathname === '/api/merchant/orders' && req.method === 'GET') {
      const merchantId = req.authorizedMerchantId || parsedUrl.query.merchant_id || parsedUrl.query.merchantId;
      const month = parsedUrl.query.month || null;
      const resData = db.getMerchantOrders ? db.getMerchantOrders(merchantId, month) : { count: 0, orders: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...resData }));
      return true;
    }

    if (pathname === '/api/merchant/calculate-savings' && req.method === 'GET') {
      const trips = parsedUrl.query.trips || parsedUrl.query.deliveriesPerMonth || 20;
      const category = parsedUrl.query.category || parsedUrl.query.vehicleCategory || 'v_ace';
      const resData = db.calculateVehicleSavings ? db.calculateVehicleSavings(trips, category) : { netMonthlySavings: 35000 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, savings: resData }));
      return true;
    }

    if (pathname === '/api/merchant/export/orders' && req.method === 'GET') {
      const merchantId = req.authorizedMerchantId || parsedUrl.query.merchant_id || parsedUrl.query.merchantId;
      const month = parsedUrl.query.month || null;
      const resData = db.getMerchantOrders ? db.getMerchantOrders(merchantId, month) : { orders: [] };

      let csv = 'Trip ID,Sender Name,Pickup Address,Drop Address,Vehicle,Total Fare (INR),Status,Date\n';
      (resData.orders || []).forEach(o => {
        csv += [o.id, o.senderName || 'B2B Client', o.pickupAddress || '', o.dropAddress || '', o.vehicleName || '', o.totalFare || 0, o.status || 'DELIVERED', o.createdAt || ''].map(csvCell).join(',') + '\n';
      });

      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="vaayu_b2b_monthly_orders.csv"'
      });
      res.end(csv);
      return true;
    }

    if (pathname === '/api/merchant/sla-metrics' && req.method === 'GET') {
      const merchantId = req.authorizedMerchantId || parsedUrl.query.merchant_id || parsedUrl.query.merchantId;
      const metrics = slaService.getMerchantSlaMetrics(merchantId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, metrics }));
      return true;
    }

    if (pathname === '/api/admin/sla-analytics' && req.method === 'GET') {
      const analytics = slaService.getGlobalSlaAnalytics();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, analytics }));
      return true;
    }

    if (pathname === '/api/admin/sla-breaches' && req.method === 'GET') {
      const analytics = slaService.getGlobalSlaAnalytics();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, activeBreaches: analytics.activeBreachAlerts, totalBreaches: analytics.activeBreachAlerts.length }));
      return true;
    }

    return false;
  };
}

module.exports = { createMerchantBatchRoutes };