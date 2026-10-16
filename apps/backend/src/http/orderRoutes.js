// Order lifecycle: the controlled transition route, the per-action helper routes, and the audit log. Branch logic
// is moved from server_production.js. Each matched route answers and returns true at once, so the router stops
// here, including when a guard has refused the request. Per-role permission is enforced by the delivery state
// machine's actor table, not by these routes.

function createOrderRoutes({
  db, deliveryStateMachine, redisLockManager, otpService, paymentProvider, idempotencyService, dispatchService,
  driverLocationService, DELIVERY_STATES, enforceSecurityChecks, parseJsonBody,
  paymentIntegrationService: injectedPaymentService
}) {
  // Resolve the production payment integration lazily. Unit tests frequently inject a
  // lightweight payment service; eagerly requiring the default PostgreSQL ledger here
  // would otherwise open a real DB pool before the injected dependency is considered,
  // leaving standalone Node test processes with a live handle after assertions finish.
  const paymentService = injectedPaymentService || require('../services/ledger/paymentIntegrationService').paymentIntegrationService;
  const hasLedgerPayment = (trip) => {
    const method = String(trip?.paymentInfo?.paymentMethod || '').trim().toUpperCase();
    return method === 'WALLET' || Boolean(trip?.paymentInfo?.provider === 'VAAYU_WALLET');
  };
  const handleCommandError = async (res, idempotencyService, effKey, error) => {
    if (effKey && idempotencyService && idempotencyService.abortResponse) {
      try { await idempotencyService.abortResponse(effKey); } catch (_) {}
    }
    if (res.writableEnded) return;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: { code: 'INTERNAL_COMMAND_ERROR', message: error?.message || 'The order command could not be completed. Retry with the same idempotency key.' } }));
  };
  return async function handleOrderRoute(req, res, { pathname, parsedUrl }) {
    if (pathname === '/api/orders/transition' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let effKey = null;
        try {
          const data = parseJsonBody(res, body);
          if (!data) return;
          const { orderId, nextState, idempotencyKey, reason, otp, expectedVersion, metadata } = data;
          if (!orderId || !nextState) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: { code: 'INVALID_REQUEST', message: 'orderId and nextState are required' } }));
          }
          const secPassed = await enforceSecurityChecks(req, res, { routeName: 'orders:transition', requiredRoles: ['DRIVER', 'CUSTOMER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'], targetOrderId: orderId });
          if (!secPassed) return;
          const actor = { type: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'].includes(req.user.role) ? 'ADMIN' : req.user.role, id: req.user.id };
          effKey = idempotencyKey || (req.headers ? req.headers['x-idempotency-key'] : null);
          if (effKey) {
            const existing = await idempotencyService.findExistingResponse(effKey);
            if (existing.found) {
              res.writeHead(existing.statusCode, { 'Content-Type': 'application/json' });
              return res.end(typeof existing.body === 'string' ? existing.body : JSON.stringify(existing.body));
            }
          }
          if (!actor || actor.type === 'SYSTEM') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Not permitted' } }));
          }
          const result = await deliveryStateMachine.transition(orderId, nextState, actor, { idempotencyKey: effKey, reason, otp, expectedVersion, metadata });

          if (result.success && nextState === DELIVERY_STATES.DELIVERED) {
            const completedTrip = db.getTripById ? db.getTripById(orderId) : null;
            const assignedDriverId = completedTrip?.driver?.id || completedTrip?.driver?.userId;
            const fare = completedTrip?.totalFare ?? completedTrip?.fareBreakdown?.total ?? 0;
            if (assignedDriverId && hasLedgerPayment(completedTrip)) {
              try {
                result.paymentSettlement = await paymentService.settleTrip({ tripId: orderId, driverId: assignedDriverId, amountPaise: Math.round(Number(fare) * 100), idempotencyKey: `VAAYU:${orderId}:SETTLEMENT` });
              } catch (error) {
                result.paymentSettlement = { success: false, error: { code: 'SETTLEMENT_EXCEPTION', message: error.message || 'Settlement could not be completed.' } };
              }
            }
          } else if (result.success && nextState === DELIVERY_STATES.CANCELLED) {
            const cancelledTrip = db.getTripById ? db.getTripById(orderId) : null;
            if (hasLedgerPayment(cancelledTrip)) {
              try {
                result.paymentRefund = await paymentService.refundTrip({ tripId: orderId, reason: reason || 'Order cancelled', idempotencyKey: `VAAYU:${orderId}:REFUND` });
              } catch (error) {
                result.paymentRefund = { success: false, error: { code: 'REFUND_EXCEPTION', message: error.message || 'Refund could not be completed.' } };
              }
            }
          }

          const statusCode = result.success ? 200 : 400;
          if (effKey && result.success) await idempotencyService.saveResponse(effKey, orderId, statusCode, result);
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(result));
        } catch (error) {
          return handleCommandError(res, idempotencyService, effKey, error);
        }
      });
      return true;
    }

    if (pathname.startsWith('/api/orders/') && req.method === 'POST') {
      const action = pathname.replace('/api/orders/', '');
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let effKey = null;
        try {
          const data = parseJsonBody(res, body);
          if (!data) return;
          const { orderId, idempotencyKey, reason, otp, expectedVersion, metadata } = data;
          const proof = action === 'complete' && data.proof && typeof data.proof === 'object' ? data.proof : null;
          if (proof) {
            const photoRef = typeof proof.podPhotoUrl === 'string' ? proof.podPhotoUrl.trim() : '';
            if (photoRef && !/^\/private-proof-photos\/pod_[a-f0-9]{32}\.(jpg|png|webp)$/.test(photoRef)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ success: false, error: { code: 'INVALID_PROOF_REFERENCE', message: 'Proof photo must be a reference returned by the proof upload.' } }));
            }
          }
          if (!orderId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: { code: 'INVALID_REQUEST', message: 'orderId is required' } }));
          }
          const secPassed = await enforceSecurityChecks(req, res, { routeName: 'orders:transition', requiredRoles: ['DRIVER', 'CUSTOMER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'], targetOrderId: orderId });
          if (!secPassed) return;
          const authenticatedActor = { type: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'].includes(req.user.role) ? 'ADMIN' : req.user.role, id: req.user.id };
          effKey = idempotencyKey || (req.headers ? req.headers['x-idempotency-key'] : null);
          if (effKey) {
            const existing = await idempotencyService.findExistingResponse(effKey);
            if (existing.found) {
              res.writeHead(existing.statusCode, { 'Content-Type': 'application/json' });
              return res.end(typeof existing.body === 'string' ? existing.body : JSON.stringify(existing.body));
            }
          }

          let targetState = null;
          let defaultActor = authenticatedActor;
          if (action === 'accept') targetState = DELIVERY_STATES.DRIVER_ACCEPTED;
          else if (action === 'start-arriving') targetState = DELIVERY_STATES.DRIVER_ARRIVING;
          else if (action === 'arrived-pickup') targetState = DELIVERY_STATES.DRIVER_AT_PICKUP;
          else if (action === 'confirm-pickup') targetState = DELIVERY_STATES.PICKUP_CONFIRMED;
          else if (action === 'start-transit') targetState = DELIVERY_STATES.IN_TRANSIT;
          else if (action === 'arrived-dropoff') targetState = DELIVERY_STATES.DRIVER_AT_DROPOFF;
          else if (action === 'complete') targetState = DELIVERY_STATES.DELIVERED;
          else if (action === 'cancel') targetState = DELIVERY_STATES.CANCELLED;
          if (!targetState) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: { code: 'UNKNOWN_ACTION', message: `Unknown order lifecycle action: ${action}` } }));
          }

          const result = await deliveryStateMachine.transition(orderId, targetState, defaultActor, { idempotencyKey: effKey, reason, otp, expectedVersion, metadata, proof });
          if (result.success && (action === 'complete' || action === 'confirm-pickup') && otp) {
            try { otpService.markTripOtpVerified(orderId, otp); } catch (_) {}
          }
          if (result.success && action === 'accept' && req.user.role === 'DRIVER' && dispatchService.handleDriverAccept) {
            const profile = (db.getDrivers() || []).find(driver => driver.userId === req.user.id || driver.id === req.user.id);
            if (profile) await dispatchService.handleDriverAccept(orderId, profile.id);
          }

          if (result.success && action === 'complete') {
            const completedTrip = db.getTripById ? db.getTripById(orderId) : null;
            const assignedDriverId = completedTrip?.driver?.id || completedTrip?.driver?.userId;
            if (assignedDriverId && hasLedgerPayment(completedTrip)) {
              try {
                const fare = completedTrip?.totalFare ?? completedTrip?.fareBreakdown?.total ?? 0;
                result.paymentSettlement = await paymentService.settleTrip({ tripId: orderId, driverId: assignedDriverId, amountPaise: Math.round(Number(fare) * 100), idempotencyKey: `VAAYU:${orderId}:SETTLEMENT` });
              } catch (error) {
                result.paymentSettlement = { success: false, error: { code: 'SETTLEMENT_EXCEPTION', message: error.message || 'Settlement could not be completed.' } };
              }
            }
            if (req.user.role === 'DRIVER' && db.recordDriverTripCompletion) {
              const profile = (db.getDrivers() || []).find(driver => driver.id === assignedDriverId || driver.userId === assignedDriverId);
              if (profile) {
                const earnings = Number(completedTrip.driverEarnings ?? completedTrip.totalFare ?? completedTrip.fareBreakdown?.total ?? 0);
                db.recordDriverTripCompletion(profile.id, orderId, earnings);
                if (db.updateDriverProfile) db.updateDriverProfile(profile.id, { status: 'ONLINE' });
                if (driverLocationService.setDriverAvailability) await driverLocationService.setDriverAvailability(profile.id, true);
              }
            }
          }

          if (result.success && action === 'cancel') {
            const currentTrip = db.getTripById ? db.getTripById(orderId) : null;
            if (currentTrip && currentTrip.driver && currentTrip.driver.id) {
              const lockInfo = await redisLockManager.getDriverLock(currentTrip.driver.id);
              if (lockInfo && lockInfo.orderId === orderId) await redisLockManager.releaseDriverLock(currentTrip.driver.id, lockInfo.reservationId);
            }
            if (hasLedgerPayment(currentTrip)) {
              try {
                result.paymentRefund = await paymentService.refundTrip({ tripId: orderId, reason: reason || 'Customer Order Cancellation', idempotencyKey: `VAAYU:${orderId}:REFUND` });
              } catch (error) {
                result.paymentRefund = { success: false, error: { code: 'REFUND_EXCEPTION', message: error.message || 'Refund could not be completed.' } };
              }
            }

            const paidTransaction = db.getPaymentForBooking ? db.getPaymentForBooking(orderId) : null;
            let refundRes = { success: false, refundIssued: false, status: 'NOT_APPLICABLE', reason: 'No captured online payment is linked to this booking.' };
            if (paidTransaction?.razorpayPaymentId) {
              try {
                refundRes = await paymentProvider.refundPayment(paidTransaction.razorpayPaymentId, paidTransaction.amount, reason || 'Customer Order Cancellation');
                if (refundRes.refundIssued && db.recordPaymentRefund) db.recordPaymentRefund(paidTransaction.razorpayPaymentId, refundRes);
              } catch (error) {
                refundRes = { success: false, refundIssued: false, status: 'REFUND_FAILED', error: error.message };
              }
            }
            result.refundInfo = refundRes;
            if (paidTransaction?.razorpayPaymentId && refundRes.success === false) result.paymentRefund = { success: false, error: { code: 'PROVIDER_REFUND_FAILED', message: refundRes.error || refundRes.status || 'Provider refund failed.' } };
          }

          const statusCode = result.success ? 200 : 400;
          if (effKey && result.success) await idempotencyService.saveResponse(effKey, orderId, statusCode, result);
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(result));
        } catch (error) {
          return handleCommandError(res, idempotencyService, effKey, error);
        }
      });
      return true;
    }

    if (pathname === '/api/orders/audit' && req.method === 'GET') {
      const orderId = parsedUrl.query.orderId;
      if (!orderId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'orderId query parameter is required' }));
        return true;
      }
      const secPassed = await enforceSecurityChecks(req, res, { requiredRoles: ['CUSTOMER', 'DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'], targetOrderId: orderId });
      if (!secPassed) return true;
      const logs = deliveryStateMachine.getAuditLogs(orderId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, orderId, count: logs.length, auditLogs: logs }));
      return true;
    }
    return false;
  };
}

module.exports = { createOrderRoutes };