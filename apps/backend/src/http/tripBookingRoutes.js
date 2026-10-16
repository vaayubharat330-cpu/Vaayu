// Fare estimate and trip creation. Branch logic is moved from server_production.js. Each matched route
// answers and returns true at once, so the router stops here, including when a guard has refused the request.
// Earlier fixes are kept: the delivery PIN uses crypto.randomInt, and a booking without a signed-in customer
// is refused with 401 rather than assigned a fixed customer ID.

const { paymentIntegrationService: defaultPaymentIntegrationService } = require('../services/ledger/paymentIntegrationService');

function createTripBookingRoutes({
  db, fareQuoteProvider, isAdminFeatureEnabled, idempotencyService, paymentProvider, otpService,
  orderIdService, portalContextService, metricsService, logger, dispatchService, DELIVERY_STATES,
  parseJsonBody, validateFields, isLatitude, isLongitude, enforceSecurityChecks, crypto, redisRateLimiter,
  paymentIntegrationService: injectedPaymentService
}) {
  const paymentService = injectedPaymentService || defaultPaymentIntegrationService;
  return async function handleTripBookingRoute(req, res, { pathname }) {
    if (pathname === '/api/trips/estimate' && req.method === 'POST') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body); if (!data) return;
        const rateCheck = await redisRateLimiter.checkRateLimit(req, res, 'public:map');
        if (rateCheck.error && process.env.NODE_ENV === 'production') { res.writeHead(503, {'Content-Type':'application/json'}); return res.end(JSON.stringify({success:false,error:'Security rate limiting is unavailable.'})); }
        if (!rateCheck.allowed) { res.writeHead(429, {'Content-Type':'application/json'}); return res.end(JSON.stringify({success:false,error:rateCheck.message || 'Too many requests. Try again later.'})); }
        if (data.isOutstation && !isAdminFeatureEnabled('enableOutstation')) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({success:false,error:'Outstation bookings are currently disabled.'})); }
        if (data.vehicleId === 'v_17ft' && !isAdminFeatureEnabled('enable17ftTruck')) { res.writeHead(403, {'Content-Type':'application/json'}); return res.end(JSON.stringify({success:false,error:'The 17ft truck category is currently disabled.'})); }
        const pLat=Number(data.pickupLat),pLng=Number(data.pickupLng),dLat=Number(data.dropLat),dLng=Number(data.dropLng);
        if ([[pLat,pLng],[dLat,dLng]].some(([lat,lng])=>!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({success:false,error:'Valid pickup and drop coordinates are required.'})); }
        const helperCount=parseInt(data.helperCount||0,10),extraDropsCount=parseInt(data.extraDropsCount||0,10),waitingTimeMinutes=isAdminFeatureEnabled('enableWaitingTimeBilling')?parseInt(data.waitingTimeMinutes||0,10):0;
        const quote=await fareQuoteProvider.getFareQuote(pLat,pLng,dLat,dLng,{vehicleId:data.vehicleId,helperCount,extraDropsCount,isOutstation:Boolean(data.isOutstation),intermediateStops:Array.isArray(data.intermediateStops)?data.intermediateStops:[],waitingTimeMinutes});
        if(!quote.success){res.writeHead(403,{'Content-Type':'application/json'});return res.end(JSON.stringify(quote));}
        res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(quote));
      }); return true;
    }

    if (pathname === '/api/trips/create' && req.method === 'POST') {
      let body=''; req.on('data',chunk=>{body+=chunk;});
      req.on('end',async()=>{
        let idempotencyOwned=false,idempotencyFinalized=false,effKey=null,walletEscrowCreated=false,tripPersisted=false;
        let walletEscrowKey=null,tempOrderIdForRollback=null;
        try {
          const secPassed=await enforceSecurityChecks(req,res,{routeName:'trips:create',requiredRoles:['CUSTOMER','ADMIN','SUPER_ADMIN']}); if(!secPassed)return;
          const data=parseJsonBody(res,body); if(!data)return; data.customerId=req.user.id;
          if(data.isOutstation&&!isAdminFeatureEnabled('enableOutstation')){res.writeHead(403,{'Content-Type':'application/json'});return res.end(JSON.stringify({success:false,error:'Outstation bookings are currently disabled.'}));}
          if(data.vehicleId==='v_17ft'&&!isAdminFeatureEnabled('enable17ftTruck')){res.writeHead(403,{'Content-Type':'application/json'});return res.end(JSON.stringify({success:false,error:'The 17ft truck category is currently disabled.'}));}
          effKey=data.idempotencyKey||(req.headers?req.headers['x-idempotency-key']:null);
          if(effKey){const existing=await idempotencyService.findExistingResponse(effKey);if(existing.found){res.writeHead(existing.statusCode,{'Content-Type':'application/json'});return res.end(typeof existing.body==='string'?existing.body:JSON.stringify(existing.body));}idempotencyOwned=true;}
          const coord=v=>(typeof v==='string'&&v.trim()!==''?Number(v):v);const pLat=coord(data.pickupLat),pLng=coord(data.pickupLng),dLat=coord(data.dropLat),dLng=coord(data.dropLng);
          if(!validateFields(res,[[isLatitude(pLat),'pickupLat must be a valid latitude'],[isLongitude(pLng),'pickupLng must be a valid longitude'],[isLatitude(dLat),'dropLat must be a valid latitude'],[isLongitude(dLng),'dropLng must be a valid longitude']]))return;
          const vehicleId=data.vehicleId||'v_ace',helperCount=parseInt(data.helperCount||0,10),extraDropsCount=parseInt(data.extraDropsCount||0,10),waitingTimeMinutes=isAdminFeatureEnabled('enableWaitingTimeBilling')?parseInt(data.waitingTimeMinutes||0,10):0,driverTip=Math.max(0,parseInt(data.driverTip||0,10)),isOutstation=Boolean(data.isOutstation),intermediateStops=Array.isArray(data.intermediateStops)?data.intermediateStops:[];
          const goodsCategory=data.goodsCategory||'House Furniture & Appliances',isFragile=Boolean(data.isFragile),goodsNotes=data.goodsNotes||'',dispatchMode=data.dispatchMode||'NOW',scheduledDate=data.scheduledDate||new Date().toISOString().split('T')[0],scheduledTimeSlot=data.scheduledTimeSlot||'09:00 AM - 10:00 AM';
          const quoteRes=await fareQuoteProvider.getFareQuote(pLat,pLng,dLat,dLng,{vehicleId,helperCount,extraDropsCount,isOutstation,intermediateStops,waitingTimeMinutes});
          if(!quoteRes.success){res.writeHead(403,{'Content-Type':'application/json'});return res.end(JSON.stringify(quoteRes));}
          const vehicleEstimate=quoteRes.selectedEstimate,pickupOtp=crypto.randomInt(1000,10000).toString(),deliveryOtp=crypto.randomInt(1000,10000).toString();
          const finalFareBreakdown={...vehicleEstimate.fareBreakdown,driverTip},finalTotalFare=vehicleEstimate.totalFare+driverTip;
          const customerId=req.user&&req.user.id;if(!customerId){res.writeHead(401,{'Content-Type':'application/json'});return res.end(JSON.stringify({success:false,error:'Sign in to book a trip.'}));}
          const portalContext=req.portalContext||portalContextService.extractPortalContext(req);
          const tempOrderId=orderIdService.generateOrderId({portal:portalContext.portalId,category:data.isRecurring?'RECURRING':(data.isEmergency?'EMERGENCY':'EXPRESS'),region:'HYD'}); tempOrderIdForRollback=tempOrderId;
          const paymentMethod=String(data.paymentMethod||'CASH_ON_DELIVERY').toUpperCase();
          const isCashPayment=['CASH','COD','CASH_ON_DELIVERY'].includes(paymentMethod);
          if(paymentMethod!=='WALLET'&&!isCashPayment){
            if(effKey) await idempotencyService.abortResponse(effKey);
            idempotencyOwned=false;
            res.writeHead(402,{'Content-Type':'application/json'});
            return res.end(JSON.stringify({success:false,error:{code:'PAYMENT_METHOD_NOT_READY',message:'This payment method is not enabled for booking yet. Use CASH_ON_DELIVERY or WALLET.'}}));
          }
          let paymentInfo;
          if(paymentMethod==='WALLET'){
            const farePaise=Math.round(Number(finalTotalFare)*100);walletEscrowKey=effKey?`VAAYU:${effKey}:ESCROW`:`VAAYU:${tempOrderId}:ESCROW`;
            const escrowResult=await paymentService.reserveEscrow({tripId:tempOrderId,orderId:tempOrderId,customerId,amountPaise:farePaise,idempotencyKey:walletEscrowKey});
            if(!escrowResult.success){res.writeHead(402,{'Content-Type':'application/json'});return res.end(JSON.stringify({success:false,error:escrowResult.error?.message||'Wallet payment could not be completed.'}));}
            walletEscrowCreated=true;
            paymentInfo={success:true,provider:'VAAYU_WALLET',status:'PAID',requiresPayment:false,isPaid:true,deferred:false,orderId:tempOrderId,amount:finalTotalFare,paymentMethod,timestamp:new Date().toISOString(),escrow:escrowResult};
          } else paymentInfo=await paymentProvider.processPayment(tempOrderId,finalTotalFare,paymentMethod);
          const newTrip={id:tempOrderId,tripId:tempOrderId,customerId,customerName:data.senderName||(req.user?req.user.name:null),customerPhone:data.senderPhone||(req.user?req.user.phone:null),vehicleId,vehicleName:vehicleEstimate.vehicleName,isOutstation,goodsCategory,isFragile,goodsNotes,dispatchMode,scheduledDate,scheduledTimeSlot,pickupAddress:data.pickupAddress||'Custom Pickup Location',pickupLat:pLat,pickupLng:pLng,dropAddress:data.dropAddress||'Custom Drop Location',dropLat:dLat,dropLng:dLng,intermediateStops,distanceKm:quoteRes.distanceKm,durationMin:quoteRes.durationMin,fareBreakdown:finalFareBreakdown,totalFare:finalTotalFare,fareProvider:quoteRes.provider,paymentInfo,pickupOtp,deliveryOtp,trackingToken:crypto.randomBytes(32).toString('base64url'),version:1,status:DELIVERY_STATES.CREATED,driver:null,createdAt:new Date().toISOString()};
          orderIdService.attachInternalValues(newTrip,portalContext); db.createTrip(newTrip); tripPersisted=true;
          try{const customerPhone=req.user?.phone||newTrip.customerPhone||null;otpService.recordDeliveryOtp(customerPhone,deliveryOtp,newTrip.id,'TRIP_DELIVERY');}catch(_){ }
          metricsService.increment('orders_created_total');logger.info('order_created',`New trip order created ${newTrip.id}`,{orderId:newTrip.id,customerId:newTrip.customerId});
          const dispatchRes=await dispatchService.findAndOfferDriver(newTrip.id);const createdTrip=db.getTripById(newTrip.id);
          const responseTrip={...(createdTrip||newTrip)};delete responseTrip.deliveryOtp;
          const responsePayload={success:true,trip:responseTrip,dispatch:dispatchRes};
          if(effKey){await idempotencyService.saveResponse(effKey,newTrip.id,200,responsePayload);idempotencyFinalized=true;}
          res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(responsePayload));
        } catch(err){
          logger.error('trip_booking_failed',err.message,{idempotencyKey:effKey});
          if(walletEscrowCreated&&!tripPersisted&&tempOrderIdForRollback){try{await paymentService.refundTrip({tripId:tempOrderIdForRollback,amountPaise:null,reason:'Booking persistence failed before trip creation',idempotencyKey:`${walletEscrowKey}:ROLLBACK`});}catch(refundError){logger.error('trip_booking_escrow_rollback_failed',refundError.message,{tripId:tempOrderIdForRollback});}}
          if(!res.writableEnded){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({success:false,error:'Trip booking could not be completed.'}));}
        } finally {if(effKey&&idempotencyOwned&&!idempotencyFinalized){try{await idempotencyService.abortResponse(effKey);}catch(_){}}}
      }); return true;
    }
    return false;
  };
}
module.exports={createTripBookingRoutes};