// Fare estimate and trip creation. Branch logic is moved from server_production.js. Each matched route
// answers and returns true at once, so the router stops here, including when a guard has refused the request.
// Earlier fixes are kept: the delivery PIN uses crypto.randomInt, and a booking without a signed-in customer
// is refused with 401 rather than assigned a fixed customer ID.

function createTripBookingRoutes({
  db, fareQuoteProvider, isAdminFeatureEnabled, idempotencyService, paymentProvider, otpService,
  orderIdService, portalContextService, metricsService, logger, dispatchService, DELIVERY_STATES,
  parseJsonBody, validateFields, isLatitude, isLongitude, enforceSecurityChecks, crypto, redisRateLimiter
}) {
  return async function handleTripBookingRoute(req, res, { pathname }) {
    // Dynamic trip estimate. Public, so the customer can price a trip before signing in.
    if (pathname === '/api/trips/estimate' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        const rateCheck = await redisRateLimiter.checkRateLimit(req, res, 'public:map');
        if (rateCheck.error && process.env.NODE_ENV === 'production') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Security rate limiting is unavailable.' }));
        }
        if (!rateCheck.allowed) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: rateCheck.message || 'Too many requests. Try again later.' }));
        }

        if (data.isOutstation && !isAdminFeatureEnabled('enableOutstation')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Outstation bookings are currently disabled.' }));
        }
        if (data.vehicleId === 'v_17ft' && !isAdminFeatureEnabled('enable17ftTruck')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'The 17ft truck category is currently disabled.' }));
        }

        const pLat = Number(data.pickupLat);
        const pLng = Number(data.pickupLng);
        const dLat = Number(data.dropLat);
        const dLng = Number(data.dropLng);
        if ([[pLat, pLng], [dLat, dLng]].some(([lat, lng]) =>
          !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Valid pickup and drop coordinates are required.' }));
        }
        const helperCount = parseInt(data.helperCount || 0, 10);
        const extraDropsCount = parseInt(data.extraDropsCount || 0, 10);
        const waitingTimeMinutes = isAdminFeatureEnabled('enableWaitingTimeBilling') ? parseInt(data.waitingTimeMinutes || 0, 10) : 0;
        const isOutstation = Boolean(data.isOutstation);
        const intermediateStops = Array.isArray(data.intermediateStops) ? data.intermediateStops : [];

        const quote = await fareQuoteProvider.getFareQuote(pLat, pLng, dLat, dLng, {
          vehicleId: data.vehicleId,
          helperCount,
          extraDropsCount,
          isOutstation,
          intermediateStops,
          waitingTimeMinutes
        });

        if (!quote.success) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(quote));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(quote));
      });
      return true;
    }

    // Create a booking (trip order).
    if (pathname === '/api/trips/create' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const secPassed = await enforceSecurityChecks(req, res, { routeName: 'trips:create', requiredRoles: ['CUSTOMER', 'ADMIN', 'SUPER_ADMIN'] });
        if (!secPassed) return;
        const data = parseJsonBody(res, body);
        if (!data) return;
        data.customerId = req.user.id;

        if (data.isOutstation && !isAdminFeatureEnabled('enableOutstation')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Outstation bookings are currently disabled.' }));
        }
        if (data.vehicleId === 'v_17ft' && !isAdminFeatureEnabled('enable17ftTruck')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'The 17ft truck category is currently disabled.' }));
        }

        // Durable idempotency: a repeated request with the same key returns the first response.
        const effKey = data.idempotencyKey || (req.headers ? req.headers['x-idempotency-key'] : null);
        if (effKey) {
          const existing = await idempotencyService.findExistingResponse(effKey);
          if (existing.found) {
            res.writeHead(existing.statusCode, { 'Content-Type': 'application/json' });
            return res.end(typeof existing.body === 'string' ? existing.body : JSON.stringify(existing.body));
          }
        }

        // Coordinates are required and must be valid. A missing or bad coordinate is refused, never replaced by a default place.
        const coord = v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
        const pLat = coord(data.pickupLat), pLng = coord(data.pickupLng);
        const dLat = coord(data.dropLat), dLng = coord(data.dropLng);
        if (!validateFields(res, [
          [isLatitude(pLat), 'pickupLat must be a valid latitude'],
          [isLongitude(pLng), 'pickupLng must be a valid longitude'],
          [isLatitude(dLat), 'dropLat must be a valid latitude'],
          [isLongitude(dLng), 'dropLng must be a valid longitude'],
        ])) return;

        const vehicleId = data.vehicleId || 'v_ace';
        const helperCount = parseInt(data.helperCount || 0, 10);
        const extraDropsCount = parseInt(data.extraDropsCount || 0, 10);
        const waitingTimeMinutes = isAdminFeatureEnabled('enableWaitingTimeBilling') ? parseInt(data.waitingTimeMinutes || 0, 10) : 0;
        const driverTip = Math.max(0, parseInt(data.driverTip || 0, 10));
        const isOutstation = Boolean(data.isOutstation);
        const intermediateStops = Array.isArray(data.intermediateStops) ? data.intermediateStops : [];

        const goodsCategory = data.goodsCategory || 'House Furniture & Appliances';
        const isFragile = Boolean(data.isFragile);
        const goodsNotes = data.goodsNotes || '';
        const dispatchMode = data.dispatchMode || 'NOW';
        const scheduledDate = data.scheduledDate || new Date().toISOString().split('T')[0];
        const scheduledTimeSlot = data.scheduledTimeSlot || '09:00 AM - 10:00 AM';

        const quoteRes = await fareQuoteProvider.getFareQuote(pLat, pLng, dLat, dLng, {
          vehicleId,
          helperCount,
          extraDropsCount,
          isOutstation,
          intermediateStops,
          waitingTimeMinutes
        });

        if (!quoteRes.success) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(quoteRes));
        }

        const vehicleEstimate = quoteRes.selectedEstimate;
        const pickupOtp = crypto.randomInt(1000, 10000).toString();
        const deliveryOtp = crypto.randomInt(1000, 10000).toString();

        const finalFareBreakdown = {
          ...vehicleEstimate.fareBreakdown,
          driverTip
        };
        const finalTotalFare = vehicleEstimate.totalFare + driverTip;

        // A booking is always made for a signed-in customer. No fixed customer ID is ever substituted.
        const customerId = req.user && req.user.id;
        if (!customerId) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Sign in to book a trip.' }));
        }
        const portalContext = req.portalContext || portalContextService.extractPortalContext(req);
        const tempOrderId = orderIdService.generateOrderId({
          portal: portalContext.portalId,
          category: data.isRecurring ? 'RECURRING' : (data.isEmergency ? 'EMERGENCY' : 'EXPRESS'),
          region: 'HYD'
        });
        const paymentMethod = String(data.paymentMethod || 'CASH_ON_DELIVERY').toUpperCase();
        let paymentInfo;
        if (paymentMethod === 'WALLET') {
          const debit = db.debitCustomerWallet ? db.debitCustomerWallet(customerId, finalTotalFare, tempOrderId) : { success: false, error: 'Wallet payments are unavailable.' };
          if (!debit.success) {
            res.writeHead(402, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: debit.error || 'Wallet payment could not be completed.' }));
          }
          paymentInfo = { success: true, provider: 'VAAYU_WALLET', status: 'PAID', requiresPayment: false, isPaid: true, deferred: false, orderId: tempOrderId, amount: finalTotalFare, paymentMethod, timestamp: new Date().toISOString() };
        } else {
          paymentInfo = await paymentProvider.processPayment(tempOrderId, finalTotalFare, paymentMethod);
        }

        const newTrip = {
          id: tempOrderId,
          tripId: tempOrderId,
          customerId,
          customerName: data.senderName || (req.user ? req.user.name : null),
          customerPhone: data.senderPhone || (req.user ? req.user.phone : null),
          vehicleId,
          vehicleName: vehicleEstimate.vehicleName,
          isOutstation,
          goodsCategory,
          isFragile,
          goodsNotes,
          dispatchMode,
          scheduledDate,
          scheduledTimeSlot,
          pickupAddress: data.pickupAddress || 'Custom Pickup Location',
          pickupLat: pLat,
          pickupLng: pLng,
          dropAddress: data.dropAddress || 'Custom Drop Location',
          dropLat: dLat,
          dropLng: dLng,
          intermediateStops,
          distanceKm: quoteRes.distanceKm,
          durationMin: quoteRes.durationMin,
          fareBreakdown: finalFareBreakdown,
          totalFare: finalTotalFare,
          fareProvider: quoteRes.provider,
          paymentInfo,
          pickupOtp,
          deliveryOtp,
          trackingToken: crypto.randomBytes(32).toString('base64url'),
          version: 1,
          status: DELIVERY_STATES.CREATED,
          // DispatchService attaches a driver only after it reserves a matching
          // eligible driver and transitions the trip to DRIVER_ASSIGNED.
          driver: null,
          createdAt: new Date().toISOString()
        };

        orderIdService.attachInternalValues(newTrip, portalContext);
        db.createTrip(newTrip);
        try {
          const customerPhone = req.user?.phone || newTrip.customerPhone || null;
          otpService.recordDeliveryOtp(customerPhone, deliveryOtp, newTrip.id, 'TRIP_DELIVERY');
        } catch (_) {}
        metricsService.increment('orders_created_total');
        logger.info('order_created', `New trip order created ${newTrip.id}`, { orderId: newTrip.id, customerId: newTrip.customerId });

        // Trigger deterministic dispatch matcher.
        const dispatchRes = await dispatchService.findAndOfferDriver(newTrip.id);

        const createdTrip = db.getTripById(newTrip.id);

        const responsePayload = {
          success: true,
          trip: createdTrip || newTrip,
          dispatch: dispatchRes
        };

        if (effKey) {
          await idempotencyService.saveResponse(effKey, newTrip.id, 200, responsePayload);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(responsePayload));
      });
      return true;
    }

    return false;
  };
}

module.exports = { createTripBookingRoutes };
