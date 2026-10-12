// Driver partner APIs: profile, offers, status update, payouts, driver documents and KYC steps, trip rejections with
// video proof, telemetry ping, and customer feedback. Branch logic is moved from server_production.js. Each matched route
// answers and returns true at once, so the router stops here, including when a guard has refused the request.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateFields } = require('./helpers');

// Same folders as before the move: this file sits one level deeper than server_production.js, so resolve from the backend root.
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const PRIVATE_DRIVER_DOCUMENTS = path.resolve(BACKEND_ROOT, 'private_uploads', 'driver_documents');
const PUBLIC_DRIVER_DOCUMENTS = path.resolve(BACKEND_ROOT, 'public', 'driver', 'uploads', 'documents');
const PUBLIC_ROOT = path.resolve(BACKEND_ROOT, 'public');
const REJECTION_PROOFS = path.resolve(BACKEND_ROOT, 'private_uploads', 'rejection_proofs');

function createDriverPartnerRoutes({
  db, dispatchService, driverLocationService, redisLockManager, documentOcrProvider, deliveryStateMachine, DELIVERY_STATES,
  enforceSecurityChecks, enforceDriverAccess, parseJsonBody
}) {
  return async function handleDriverPartnerRoute(req, res, { pathname, parsedUrl }) {
    if ((pathname === '/api/driver' || pathname === '/api/driver/profile') && req.method === 'GET') {
      const driverId = parsedUrl.query.id || null;
      if (!await enforceDriverAccess(req, res, driverId, 'driver:profile')) return true;
      const drivers = db.getDrivers ? db.getDrivers() : [];
      let driver = drivers.find(d => d.id === req.authorizedDriverId || d.userId === req.authorizedDriverId || d.id === driverId || d.userId === driverId);
      if (driver) {
        const payouts = db.getPayouts ? db.getPayouts(driver.id) : [];
        const daily_logs = db.getDailyLogs ? db.getDailyLogs(driver.id) : [];
        const allTrips = db.getTrips ? db.getTrips() : [];
        const driverTrips = allTrips.filter(trip => trip.driver && String(trip.driver.id || trip.driver.userId) === String(driver.id));
        const completedTrips = driverTrips.filter(t => t.status === 'DELIVERED');
        
        // Dynamic calculations from database
        const totalTripsCount = Math.max(Number(driver.totalTrips || 0), completedTrips.length);
        const todayTripsCount = Number(driver.todayTrips ?? (daily_logs.find(l => l.isToday)?.trips ?? completedTrips.length));
        const todayEarningsVal = Number(driver.todayEarnings ?? (daily_logs.find(l => l.isToday)?.earnings ?? 0));

        // Real dynamic rating calculation from customer feedback or driver profile
        const allFeedback = (db.readDb ? (db.readDb().feedback || []) : []).filter(f => String(f.driverId) === String(driver.id) || String(f.driverId) === String(driver.userId));
        let computedRating = null;
        if (allFeedback.length > 0) {
          computedRating = (allFeedback.reduce((sum, f) => sum + Number(f.rating || 5), 0) / allFeedback.length).toFixed(2);
        } else if (driver.rating !== null && driver.rating !== undefined && driver.rating !== '') {
          computedRating = Number(driver.rating).toFixed(2);
        }

        // Real dynamic acceptance rate calculation from completed/accepted trips vs rejections
        const rejections = (db.readDb ? (db.readDb().order_rejections || []) : []).filter(r => String(r.driverId) === String(driver.id) || String(r.driverId) === String(driver.userId));
        const totalOfferInteractions = driverTrips.length + rejections.length;
        let computedAcceptanceRate = null;
        if (totalOfferInteractions > 0) {
          const rate = (driverTrips.length / totalOfferInteractions) * 100;
          computedAcceptanceRate = `${rate.toFixed(1)}%`;
        } else if (driver.acceptanceRate !== null && driver.acceptanceRate !== undefined && driver.acceptanceRate !== '') {
          computedAcceptanceRate = `${Number(driver.acceptanceRate).toFixed(1)}%`;
        } else if (totalTripsCount > 0) {
          computedAcceptanceRate = '100.0%';
        }

        const activeTrips = driverTrips.filter(trip =>
          !['CREATED', 'SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'DELIVERED', 'CANCELLED', 'FAILED'].includes(trip.status)
        ).map(trip => {
          const { deliveryOtp, pickupOtp, trackingToken, ...safeTrip } = trip;
          return safeTrip;
        });

        const cleanPhone = String(driver.phone || '').replace(/\D/g, '').slice(-10);
        const driverApp = (db.getDb().driver_applications || []).find(a => String(a.phone || '').replace(/\D/g, '').slice(-10) === cleanPhone);
        const resolvedVehicleNumber = driver.vehicleNumber || driver.vehiclePlate || (driverApp ? driverApp.vehicleNumber : null);
        const resolvedLicenseNumber = driver.licenseNumber || (driverApp ? driverApp.licenseNumber : null);
        const resolvedKycStatus = driver.kycStatus || (driverApp ? (driverApp.status === 'APPROVED' ? 'APPROVED' : driverApp.status) : 'APPROVED');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          profile: driver,
          ...driver,
          partner_id: driver.userId || driver.id,
          today_earnings: todayEarningsVal,
          today_trips: todayTripsCount,
          today_bonus: Number(driver.todayBonus ?? 0),
          total_trips: totalTripsCount,
          rating: computedRating,
          acceptance_rate: computedAcceptanceRate,
          pocket_balance: Number(driver.pocketBalance ?? 0),
          available_cash_limit: Number(driver.availableCashLimit ?? 1500),
          cod_cash_in_hand: Number(driver.codCashInHand ?? 0),
          payout_upi_id: driver.payoutUpiId || driver.upiId || (payouts[0] ? payouts[0].upiId : null),
          bank_account: driver.bankAccount || null,
          avg_delivery_mins: driver.avgDeliveryMins ? Number(driver.avgDeliveryMins) : null,
          yesterday_diff_trips: driver.yesterdayDiffTrips !== undefined ? Number(driver.yesterdayDiffTrips) : null,
          vehicle_id: driver.vehicleId,
          vehicle_number: resolvedVehicleNumber,
          vehicle_plate: resolvedVehicleNumber,
          license_number: resolvedLicenseNumber,
          kyc_status: resolvedKycStatus,
          payouts,
          daily_logs,
          activeTrips
        }));
        return true;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Driver profile not found' }));
      return true;
    }

    if (pathname === '/api/driver/offers' && req.method === 'GET') {
      if (!await enforceDriverAccess(req, res, parsedUrl.query.id || null, 'driver:offers')) return true;
      const offers = dispatchService.getActiveOffersForDriver(req.authorizedDriverId);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: true, offers }));
      return true;
    }

    if (pathname === '/api/driver/update' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        const driverId = data.driver_id || null;
        if (!await enforceDriverAccess(req, res, driverId, 'driver:update')) return;
        const changes = {};
        if (['ONLINE', 'OFFLINE', 'ON_TRIP'].includes(data.status)) changes.status = data.status;
        if (changes.status === 'OFFLINE') {
          const activeStatuses = new Set(['DRIVER_ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_AT_PICKUP', 'PICKUP_CONFIRMED', 'IN_TRANSIT', 'DRIVER_AT_DROPOFF']);
          const activeTrip = (db.getTrips() || []).find(trip => activeStatuses.has(trip.status) && String(trip.driver?.id || trip.driver?.userId) === String(req.authorizedDriverId));
          if (activeTrip) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: { code: 'DRIVER_HAS_ACTIVE_TRIP', message: 'Complete or resolve the active delivery before going offline.' } }));
          }
        }
        if (typeof data.vehicle_id === 'string' && db.getVehicles().some(vehicle => vehicle.id === data.vehicle_id)) changes.vehicleId = data.vehicle_id;
        if (typeof data.vehicle_number === 'string') {
          const cleanPlate = data.vehicle_number.trim().toUpperCase();
          if (cleanPlate) {
            changes.vehicleNumber = cleanPlate;
            changes.vehiclePlate = cleanPlate;
          }
        }
        if (typeof data.vehicle_plate === 'string') {
          const cleanPlate = data.vehicle_plate.trim().toUpperCase();
          if (cleanPlate) {
            changes.vehicleNumber = cleanPlate;
            changes.vehiclePlate = cleanPlate;
          }
        }
        const latNum = Number(data.lat ?? data.latitude);
        const lngNum = Number(data.lng ?? data.longitude);
        if (Number.isFinite(latNum) && Math.abs(latNum) <= 90) changes.currentLat = latNum;
        if (Number.isFinite(lngNum) && Math.abs(lngNum) <= 180) changes.currentLng = lngNum;

        const updated = db.updateDriverProfile ? db.updateDriverProfile(req.authorizedDriverId, changes) : (changes.status && db.updateDriverStatus ? db.updateDriverStatus(req.authorizedDriverId, changes.status) : null);
        if (changes.status && changes.status !== 'ON_TRIP' && driverLocationService.setDriverAvailability) {
          await driverLocationService.setDriverAvailability(req.authorizedDriverId, changes.status === 'ONLINE');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: Boolean(updated), driver: updated }));
      });
      return true;
    }

    if (pathname === '/api/payouts' && req.method === 'GET') {
      const driverId = parsedUrl.query.driver_id || null;
      if (!await enforceDriverAccess(req, res, driverId, 'driver:payouts')) return true;
      const payouts = db.getPayouts ? db.getPayouts(driverId) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payouts));
      return true;
    }

    if (pathname === '/api/payouts/create' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceDriverAccess(req, res, data.driver_id || null, 'driver:payouts:create')) return;
        if (!Number.isFinite(Number(data.amount)) || Number(data.amount) < 1 || Number(data.amount) > 10000 || !/^[\w.-]{2,256}@[\w.-]{2,64}$/.test(String(data.upi_id || '').trim())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Enter a valid payout amount and UPI ID.' }));
        }
        const resData = db.createPayout ? db.createPayout(req.authorizedDriverId, data.amount || 500, data.method, data.upi_id) : { success: false, error: { code: 'FEATURE_UNAVAILABLE', message: 'This feature is not available on this server.' } };
        res.writeHead(resData.success ? 201 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(resData));
      });
      return true;
    }

    if (pathname === '/api/documents/file' && req.method === 'GET') {
      if (!await enforceSecurityChecks(req, res, { requiredRoles: ['DRIVER', 'ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'] })) return true;
      const docId = String(parsedUrl.query.id || '');
      const allDocs = db.getDriverDocuments ? db.getDriverDocuments() : [];
      const doc = allDocs.find(item => item.id === docId);
      if (!doc) {
        res.writeHead(404); res.end('Not found'); return true;
      }
      if (req.user.role === 'DRIVER') {
        const profile = (db.getDrivers() || []).find(driver => driver.userId === req.user.id || driver.id === req.user.id);
        if (!profile || profile.id !== doc.driverId) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Document access denied.' }));
          return true;
        }
      }
      const storedPath = String(doc.filePath || '');
      let filePath;
      if (storedPath.startsWith('/private-driver-documents/')) {
        filePath = path.resolve(PRIVATE_DRIVER_DOCUMENTS, path.basename(storedPath));
      } else if (storedPath.startsWith('/driver/uploads/documents/')) {
        filePath = path.resolve(PUBLIC_ROOT, storedPath.replace(/^\//, ''));
      }
      if (!filePath || !filePath.startsWith(PRIVATE_DRIVER_DOCUMENTS + path.sep) && !filePath.startsWith(PUBLIC_DRIVER_DOCUMENTS + path.sep)) {
        res.writeHead(404); res.end('Not found'); return true;
      }
      fs.readFile(filePath, (error, file) => {
        if (error) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath).toLowerCase();
        const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(file);
      });
      return true;
    }

    if (pathname === '/api/documents' && req.method === 'GET') {
      const driverId = parsedUrl.query.driver_id || null;
      if (!await enforceDriverAccess(req, res, driverId, 'driver:documents')) return true;
      const effectiveDriverId = req.authorizedDriverId;
      const docs = db.getDriverDocuments ? db.getDriverDocuments(effectiveDriverId) : [];
      const summary = db.getKycSummary ? db.getKycSummary(effectiveDriverId) : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ driver_id: driverId, documents: docs, kyc_summary: summary }));
    }

    if (pathname === '/api/documents/upload' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceDriverAccess(req, res, data.driver_id || null, 'driver:documents:upload')) return;
        data.driver_id = req.authorizedDriverId;
        const imageMatch = typeof data.image_data === 'string' && data.image_data.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!imageMatch) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'A JPEG, PNG, or WebP document image is required.' }));
        }
        const imageBytes = Buffer.from(imageMatch[2], 'base64');
        if (!imageBytes.length || imageBytes.length > 5 * 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Document images must be 5 MB or smaller.' }));
        }
        const uploadId = `doc_${crypto.randomBytes(16).toString('hex')}`;
        fs.mkdirSync(PRIVATE_DRIVER_DOCUMENTS, { recursive: true });
        const extension = imageMatch[1] === 'jpeg' ? 'jpg' : imageMatch[1];
        fs.writeFileSync(path.join(PRIVATE_DRIVER_DOCUMENTS, `${uploadId}.${extension}`), imageBytes, { flag: 'wx', mode: 0o600 });
        data.file_path = `/private-driver-documents/${uploadId}.${extension}`;
        let ocrResult = { configured: false, status: 'NOT_CONFIGURED', provider: null, extractedText: '', fields: {} };
        try { ocrResult = await documentOcrProvider.analyze(imageBytes, `image/${imageMatch[1]}`); }
        catch (error) { ocrResult = { configured: true, status: 'OCR_FAILED_REVIEW_REQUIRED', provider: 'AZURE_DOCUMENT_INTELLIGENCE', error: error.message, extractedText: '', fields: {} }; }
        data.ocr_data = ocrResult;
        const doc = db.saveDriverDocument ? db.saveDriverDocument(data) : {};
        const summary = db.getKycSummary ? db.getKycSummary(data.driver_id) : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: 'Document securely uploaded and queued for verification.',
          ocr: { configured: ocrResult.configured, provider: ocrResult.provider, status: ocrResult.status },
          document: doc,
          kyc_summary: summary
        }));
      });
      return true;
    }

    if (pathname === '/api/documents/ai-auto-verify' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceDriverAccess(req, res, data.driver_id || null, 'driver:documents:verification')) return;
        if (!validateFields(res, [
          [data.category === undefined || (typeof data.category === 'string' && data.category.length <= 80), 'category must be text up to 80 characters'],
          [data.owner_name === undefined || (typeof data.owner_name === 'string' && data.owner_name.length <= 120), 'owner_name must be text up to 120 characters'],
        ])) return;
        const resData = db.autoVerifyDocumentsWithAi ? db.autoVerifyDocumentsWithAi(req.authorizedDriverId, data.category, data.owner_name) : { success: false, status: 'PENDING_REVIEW', error: { code: 'FEATURE_UNAVAILABLE', message: 'Automatic document checks are not available. Your documents will be reviewed by an admin.' } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(resData));
      });
      return true;
    }

    if (pathname === '/api/documents/vehicle-details' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceDriverAccess(req, res, data.driver_id || null, 'driver:documents:update')) return;
        if (!validateFields(res, [
          [typeof data.vehicle_number === 'string' && data.vehicle_number.trim().length >= 4 && data.vehicle_number.length <= 20, 'vehicle_number is required, 4 to 20 characters'],
          [data.city === undefined || (typeof data.city === 'string' && data.city.length <= 80), 'city must be text up to 80 characters'],
        ])) return;
        const resData = db.saveVehicleDetails ? db.saveVehicleDetails(req.authorizedDriverId, data.vehicle_number, data.city, data.vehicle_type, data.body_type, data.fuel_type) : { success: false, error: { code: 'FEATURE_UNAVAILABLE', message: 'This feature is not available on this server.' } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(resData));
      });
      return true;
    }

    if (pathname === '/api/documents/driver-details' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceDriverAccess(req, res, data.driver_id || null, 'driver:documents:update')) return;
        if (!validateFields(res, [
          [data.driver_name === undefined || (typeof data.driver_name === 'string' && data.driver_name.length <= 120), 'driver_name must be text up to 120 characters'],
          [data.driver_phone === undefined || (typeof data.driver_phone === 'string' && data.driver_phone.length <= 20), 'driver_phone must be text up to 20 characters'],
        ])) return;
        const resData = db.saveDriverDetails ? db.saveDriverDetails(req.authorizedDriverId, data.is_self_driving, data.driver_name, data.driver_phone) : { success: false, error: { code: 'FEATURE_UNAVAILABLE', message: 'This feature is not available on this server.' } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(resData));
      });
      return true;
    }

    if (pathname === '/api/documents/submit-step' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceDriverAccess(req, res, data.driver_id || null, 'driver:documents:step')) return;
        if (!validateFields(res, [
          [data.step === undefined || (Number.isInteger(data.step) && data.step >= 0 && data.step <= 20), 'step must be a whole number from 0 to 20'],
        ])) return;
        const summary = db.updateKycStep ? db.updateKycStep(req.authorizedDriverId, (data.step || 1) + 1, 'PENDING_REVIEW', data.owner_name) : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, kyc_step: (data.step || 1) + 1, kyc_summary: summary }));
      });
      return true;
    }

    if (pathname === '/api/trip/rejections' && req.method === 'GET') {
      const requestedDriverId = parsedUrl.query.driver_id || parsedUrl.query.driverId || null;
      if (!await enforceDriverAccess(req, res, requestedDriverId, 'driver:rejection-history')) return true;
      const rejections = db.getOrderRejections ? db.getOrderRejections(req.authorizedDriverId) : [];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
      res.end(JSON.stringify(rejections.map(record => ({
        order_id: record.orderId,
        reason: record.reason,
        notes: record.notes,
        video_attached: Boolean(record.videoUrl),
        video_duration_seconds: record.durationSeconds,
        status: record.status,
        created_at: record.createdAt
      }))));
      return true;
    }

    if (pathname === '/api/trip/emergency-reject' && req.method === 'POST') {
      let body = '';
      let requestTooLarge = false;
      req.on('data', chunk => {
        if (requestTooLarge) return;
        if (body.length + chunk.length > 28 * 1024 * 1024) { requestTooLarge = true; body = ''; return; }
        body += chunk;
      });
      req.on('end', async () => {
        if (requestTooLarge) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Video proof exceeds the 20 MiB limit.' }));
        }
        let data = {};
        try { data = JSON.parse(body); } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload.' })); }
        if (!await enforceDriverAccess(req, res, data.driver_id || null, 'driver:rejection')) return;
        if (!String(data.order_id || '').trim() || !['vehicle_breakdown', 'customer_issue', 'package_issue'].includes(String(data.reason || '')) || String(data.notes || '').length > 1000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Order ID, a supported incident reason, and notes under 1,000 characters are required.' }));
        }
        data.driver_id = req.authorizedDriverId;
        const assignedTrip = db.getTripById ? db.getTripById(String(data.order_id)) : null;
        const assignedDriverId = assignedTrip?.driver?.id || assignedTrip?.driverId || assignedTrip?.driver_id || null;
        if (!assignedTrip || assignedTrip.status !== 'DRIVER_ASSIGNED' || assignedDriverId !== data.driver_id) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Only the driver currently assigned to an unaccepted trip can reject it.' }));
        }
        const videoMatch = /^data:(video\/(?:webm|mp4));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(data.video_data || ''));
        if (!videoMatch) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'A real WebM or MP4 video proof is required.' }));
        }
        const videoBytes = Buffer.from(videoMatch[2], 'base64');
        const validWebm = videoMatch[1] === 'video/webm' && videoBytes.length >= 4 && videoBytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
        const validMp4 = videoMatch[1] === 'video/mp4' && videoBytes.length >= 12 && videoBytes.toString('ascii', 4, 8) === 'ftyp';
        if (!videoBytes.length || videoBytes.length > 20 * 1024 * 1024 || videoBytes.toString('base64').replace(/=+$/, '') !== videoMatch[2].replace(/=+$/, '') || (!validWebm && !validMp4)) {
          res.writeHead(videoBytes.length > 20 * 1024 * 1024 ? 413 : 400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Video proof must be valid and no larger than 20 MiB.' }));
        }
        if (data.duration != null && data.duration !== '' && (!Number.isFinite(Number(data.duration)) || Number(data.duration) < 3 || Number(data.duration) > 15)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Video duration, when reported, must be between 3 and 15 seconds.' }));
        }
        const extension = videoMatch[1] === 'video/mp4' ? 'mp4' : 'webm';
        const filename = `proof_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${extension}`;
        let videoUrl;
        try {
          fs.mkdirSync(REJECTION_PROOFS, { recursive: true });
          fs.writeFileSync(path.join(REJECTION_PROOFS, filename), videoBytes, { flag: 'wx' });
          videoUrl = `/api/admin/rejections/proof?id=${encodeURIComponent(filename)}`;
        } catch (_) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Could not securely save video proof.' }));
        }

        const transition = await deliveryStateMachine.transition(String(data.order_id), DELIVERY_STATES.SEARCHING_DRIVER, { type: 'DRIVER', id: data.driver_id }, {
          idempotencyKey: `driver-reject:${data.driver_id}:${data.order_id}`,
          reason: `Driver rejection pending review: ${data.reason}`,
          metadata: { rejectionReason: data.reason, proofRequired: true }
        });
        if (!transition.success) {
          try { fs.unlinkSync(path.join(REJECTION_PROOFS, filename)); } catch (_) {}
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: transition.error?.message || 'Trip could not be returned to dispatch.' }));
        }
        const lockInfo = await redisLockManager.getDriverLock(data.driver_id);
        if (lockInfo?.orderId === String(data.order_id)) await redisLockManager.releaseDriverLock(data.driver_id, lockInfo.reservationId);

        const driverRecords = db.getDrivers ? await db.getDrivers() : [];
        const driverProfile = driverRecords.find(driver => driver.id === data.driver_id || driver.userId === data.driver_id);

        const rej = db.createOrderRejection ? db.createOrderRejection({
          orderId: data.order_id,
          driverId: data.driver_id,
          driverName: driverProfile?.name,
          driverPhone: driverProfile?.phone,
          vehicleName: driverProfile?.vehicleName,
          reason: data.reason,
          notes: data.notes,
          videoUrl: videoUrl,
          durationSeconds: data.duration
        }) : null;

        if (!rej) {
          try { fs.unlinkSync(path.join(REJECTION_PROOFS, filename)); } catch (_) {}
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Could not record rejection for Admin review.' }));
        }

        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: 'Rejection submitted for audit and the unaccepted trip returned to driver search.',
          tripStatus: transition.trip?.status || 'SEARCHING_DRIVER',
          rejection: rej
        }));
      });
      return true;
    }

    if (pathname === '/api/telemetry/ping' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let data = {};
        try { data = JSON.parse(body); } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload' }));
        }
        if (!await enforceDriverAccess(req, res, data.driver_id, 'driver:telemetry')) return;
        if (data.lat === undefined || data.lng === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'lat and lng are required' }));
        }
        data.driver_id = req.authorizedDriverId;
        const telemetryResult = await driverLocationService.updateDriverLocation(data.driver_id, {
          lat: data.lat, lng: data.lng, speed: data.speed, bearing: data.heading ?? data.bearing,
          accuracy: data.accuracy, timestamp: data.timestamp, status: data.status, tripId: data.trip_id || data.tripId
        });
        if (!telemetryResult.success) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: telemetryResult.reason || 'Telemetry rejected' }));
        }
        const resData = db.logTelemetry ? db.logTelemetry(data.driver_id, data.lat, data.lng, data.speed, data.heading ?? data.bearing, data.status) : { success: false, error: { code: 'FEATURE_UNAVAILABLE', message: 'This feature is not available on this server.' } };
        if (db.updateDriverProfile) {
          const current = (db.getDrivers() || []).find(driver => driver.id === data.driver_id);
          const nextStatus = ['ONLINE', 'OFFLINE', 'ON_TRIP'].includes(data.status) ? data.status : current?.status;
          db.updateDriverProfile(data.driver_id, { currentLat: Number(data.lat), currentLng: Number(data.lng), ...(nextStatus ? { status: nextStatus } : {}) });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(resData));
      });
      return true;
    }

    if (pathname === '/api/feedback/submit' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const data = parseJsonBody(res, body);
        if (!data) return;
        if (!await enforceDriverAccess(req, res, data.driver_id, 'driver:feedback')) return;
        const trip = data.trip_id && db.getTripById(data.trip_id);
        if (!trip || String(trip.driver?.id || trip.driver?.userId) !== String(req.authorizedDriverId)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: { code: 'FORBIDDEN_FEEDBACK', message: 'Feedback must belong to a delivery assigned to this driver.' } }));
        }
        if (!validateFields(res, [
          [Number.isInteger(Number(data.rating)) && Number(data.rating) >= 1 && Number(data.rating) <= 5, 'rating must be a whole number from 1 to 5'],
        ])) return;
        const resData = db.recordCustomerFeedback ? db.recordCustomerFeedback(data.trip_id, req.authorizedDriverId, data.customer_name, data.rating, data.tags, data.notes || data.driver_notes, data.pair_future ?? data.pair_again) : { success: false, error: 'Feedback storage is unavailable.' };
        res.writeHead(resData.success ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(resData));
      });
      return true;
    }

    return false;
  };
}

module.exports = { createDriverPartnerRoutes };
