// Automated End-to-End Enterprise Operations Integration Test:
// Covers:
// 1. Merchant B2B Batch Booking + Geocoding verification + Dispatch trigger + Order retrieval
// 2. Customer In-Transit Trip Breakdown Reporting + Security Object-Check validation
// 3. Admin Control Tower Emergency Replacement Dispatch
// 4. Customer Support Ticket Lifecycle + AI-Assisted Refund Escalation
// 5. Admin Dispute & Cancellation Override with State Machine transition
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require(path.join(__dirname, '..', '..', 'node_modules', 'dotenv'));
const jwt = require(path.join(__dirname, '..', '..', 'node_modules', 'jsonwebtoken'));

const envFile = path.resolve(__dirname, '..', '..', '.env');
const parsed = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const secret = process.env.VAAYU_TEST_JWT_SECRET || parsed.JWT_SECRET || '';
const base = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000';

function makeToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, phone: user.phone, role: user.role, city: 'Hyderabad' },
    secret,
    { algorithm: 'HS256', expiresIn: 300 }
  );
}

test('E2E Enterprise Operations: B2B Merchant, Breakdown, Emergency Replacement, and Support Escalations', async () => {
  assert.ok(secret.length >= 32, 'JWT secret must be at least 32 chars');

  const adminToken = makeToken({ id: 'adm_e2e_ops', name: 'Ops Controller', phone: '9999999999', role: 'ADMIN' });
  const merchantPhone = '98888' + Math.floor(10000 + Math.random() * 90000);

  // -------------------------------------------------------------
  // Step 1: Merchant B2B Registration & Authentication
  // -------------------------------------------------------------
  const regRes = await fetch(base + '/api/merchant/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({
      businessName: 'Apex Logistics Hub',
      contactName: 'Operations Lead',
      phone: merchantPhone,
      address: 'Madhapur Cyber Towers, Hyderabad'
    })
  });
  const regData = await regRes.json();
  assert.equal(regRes.status, 200, 'Merchant registration must succeed: ' + JSON.stringify(regData));
  assert.ok(regData.success, 'Merchant registered successfully');
  const merchant = regData.merchant;
  const merchantId = merchant.id;
  const merchantToken = regData.token;

  // -------------------------------------------------------------
  // Step 2: Merchant B2B Batch Booking
  // -------------------------------------------------------------
  const batchRes = await fetch(base + '/api/merchant/batch-booking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + merchantToken },
    body: JSON.stringify({
      merchant_id: merchantId,
      bookings: [
        {
          pickupLat: 17.385044,
          pickupLng: 78.486671,
          dropLat: 17.448293,
          dropLng: 78.391485,
          pickupAddress: 'Charminar Warehouse A',
          dropAddress: 'Madhapur Tech Park Drop 1',
          vehicleId: 'v_ace',
          vehicleName: 'Tata Ace',
          customerName: 'Apex Client Alpha',
          customerPhone: '9111122222',
          helperCount: 1
        }
      ]
    })
  });
  const batchData = await batchRes.json();
  assert.equal(batchRes.status, 200, 'Batch booking must succeed: ' + JSON.stringify(batchData));
  assert.ok(batchData.success, 'Batch booking success flag');
  assert.ok(Array.isArray(batchData.trips) && batchData.trips.length === 1, 'One batch trip created');
  const b2bTrip = batchData.trips[0];
  assert.ok(b2bTrip.id, 'Batch trip must have an ID');

  // Verify Merchant Orders retrieval
  const merchantOrdersRes = await fetch(base + `/api/merchant/orders?merchant_id=${merchantId}`, {
    headers: { 'Authorization': 'Bearer ' + merchantToken }
  });
  const merchantOrdersData = await merchantOrdersRes.json();
  assert.equal(merchantOrdersRes.status, 200, 'Merchant orders query must succeed');
  assert.ok(merchantOrdersData.success, 'Merchant orders success');

  // -------------------------------------------------------------
  // Step 2: Create Primary Driver and Assign to B2B Trip
  // -------------------------------------------------------------
  const drvPhone1 = '90111' + Math.floor(10000 + Math.random() * 90000);
  const createDrv1Res = await fetch(base + '/api/admin/drivers/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({
      name: 'Primary Transporter',
      phone: drvPhone1,
      vehicleId: 'v_ace',
      vehicleNumber: 'TS07UA1234',
      city: 'Hyderabad'
    })
  });
  const drv1Data = await createDrv1Res.json();
  assert.equal(createDrv1Res.status, 201, 'Driver 1 creation must succeed');
  const driver1 = drv1Data.driver;

  // Approve Driver 1 KYC & Go Online
  await fetch(base + '/api/admin/drivers/update-kyc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({ driverId: driver1.id, kycStatus: 'APPROVED' })
  });

  const drv1Token = makeToken({ id: driver1.userId, name: driver1.name, phone: driver1.phone, role: 'DRIVER' });
  await fetch(base + '/api/driver/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + drv1Token },
    body: JSON.stringify({ driver_id: driver1.id, status: 'ONLINE', lat: 17.3850, lng: 78.4867 })
  });

  // Assign Driver 1 to B2B Trip
  const assignRes = await fetch(base + '/api/admin/dispatch/assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({ orderId: b2bTrip.id, driverId: driver1.id, reason: 'Assigned primary fleet transporter' })
  });
  const assignData = await assignRes.json();
  assert.equal(assignRes.status, 200, 'Manual assignment must succeed');
  assert.ok(assignData.success, 'Driver assigned');

  // -------------------------------------------------------------
  // Step 3: Breakdown Signal Reporting by Driver
  // -------------------------------------------------------------
  const breakdownRes = await fetch(base + '/api/trip/breakdown-signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + drv1Token },
    body: JSON.stringify({
      tripId: b2bTrip.id,
      driverId: driver1.id,
      lat: 17.4100,
      lng: 78.4300,
      reason: 'Radiator overheating mid-transit near Banjara Hills'
    })
  });
  const breakdownData = await breakdownRes.json();
  assert.equal(breakdownRes.status, 200, 'Breakdown alert must be recorded: ' + JSON.stringify(breakdownData));
  assert.ok(breakdownData.success, 'Breakdown success flag');

  // Verify unauthorized driver cannot signal breakdown on other trips
  const strangerToken = makeToken({ id: 'usr_stranger', name: 'Stranger Driver', phone: '9000000001', role: 'DRIVER' });
  const unauthBreakdownRes = await fetch(base + '/api/trip/breakdown-signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + strangerToken },
    body: JSON.stringify({
      tripId: b2bTrip.id,
      driverId: 'drv_stranger',
      lat: 17.4100,
      lng: 78.4300,
      reason: 'Malicious report'
    })
  });
  assert.equal(unauthBreakdownRes.status, 403, 'Unauthorized driver breakdown must be rejected with 403');

  // -------------------------------------------------------------
  // Step 4: Admin Emergency Replacement Dispatch
  // -------------------------------------------------------------
  // Create Replacement Driver 2 & Put Online
  const drvPhone2 = '90222' + Math.floor(10000 + Math.random() * 90000);
  const createDrv2Res = await fetch(base + '/api/admin/drivers/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({
      name: 'Emergency Relief Transporter',
      phone: drvPhone2,
      vehicleId: 'v_ace',
      vehicleNumber: 'TS07UB9999',
      city: 'Hyderabad'
    })
  });
  const drv2Data = await createDrv2Res.json();
  assert.equal(createDrv2Res.status, 201, 'Driver 2 creation must succeed');
  const driver2 = drv2Data.driver;

  await fetch(base + '/api/admin/drivers/update-kyc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({ driverId: driver2.id, kycStatus: 'APPROVED' })
  });

  const drv2Token = makeToken({ id: driver2.userId, name: driver2.name, phone: driver2.phone, role: 'DRIVER' });
  await fetch(base + '/api/driver/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + drv2Token },
    body: JSON.stringify({ driver_id: driver2.id, status: 'ONLINE', lat: 17.4120, lng: 78.4310 })
  });

  // Admin executes Emergency Replacement
  const emergencyRes = await fetch(base + '/api/admin/dispatch/emergency-replacement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({
      tripId: b2bTrip.id,
      replacementDriverId: driver2.id,
      reason: 'Dispatching relief cargo vehicle to breakdown site'
    })
  });
  const emergencyData = await emergencyRes.json();
  assert.equal(emergencyRes.status, 200, 'Emergency replacement must succeed: ' + JSON.stringify(emergencyData));
  assert.ok(emergencyData.success, 'Emergency dispatch success flag: ' + JSON.stringify(emergencyData));
  assert.equal(emergencyData.replacementDriver.id, driver2.id, 'Driver 2 assigned as replacement');

  // -------------------------------------------------------------
  // Step 5: Customer Support AI Chat and Ticket Escalation
  // -------------------------------------------------------------
  const custId = `usr_cust_${Date.now()}`;
  const custToken = makeToken({ id: custId, name: 'Ananya Sharma', phone: '9876543210', role: 'CUSTOMER' });

  // Standard Support Chat Inquiry
  const chatInfoRes = await fetch(base + '/api/support/ai-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + custToken },
    body: JSON.stringify({ query: 'How does live driver tracking work?' })
  });
  const chatInfoData = await chatInfoRes.json();
  assert.equal(chatInfoRes.status, 200, 'Support query response');
  assert.equal(chatInfoData.escalated, false, 'Informational query is not escalated');

  // Escalation: Refund Claim triggers Human Agent Ticket
  const refundChatRes = await fetch(base + '/api/support/ai-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + custToken },
    body: JSON.stringify({ query: 'I need a refund claim review for my delayed shipment' })
  });
  const refundChatData = await refundChatRes.json();
  assert.equal(refundChatRes.status, 200, 'Refund inquiry response');
  assert.equal(refundChatData.escalated, true, 'Refund inquiry automatically escalated to human agent');
  assert.ok(refundChatData.ticket && refundChatData.ticket.id, 'Escalation ticket generated');
  const supportTicket = refundChatData.ticket;

  // Direct Ticket Creation
  const directTicketRes = await fetch(base + '/api/support/tickets/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + custToken },
    body: JSON.stringify({
      tripId: b2bTrip.id,
      category: 'Billing',
      subject: 'Dispute over helper handling fee'
    })
  });
  const directTicketData = await directTicketRes.json();
  assert.equal(directTicketRes.status, 200, 'Ticket created');
  assert.ok(directTicketData.success, 'Ticket creation flag');

  // Admin Reviews Support Tickets
  const adminTicketsRes = await fetch(base + '/api/admin/support/tickets', {
    headers: { 'Authorization': 'Bearer ' + adminToken }
  });
  const adminTicketsData = await adminTicketsRes.json();
  assert.equal(adminTicketsRes.status, 200, 'Admin can view support tickets');
  assert.ok(adminTicketsData.success, 'Admin tickets retrieved');

  // Admin Updates Ticket
  const updateTicketRes = await fetch(base + '/api/admin/support/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({
      ticketId: supportTicket.id,
      reply: 'Your refund has been approved by the billing supervisor.',
      status: 'RESOLVED'
    })
  });
  const updateTicketData = await updateTicketRes.json();
  assert.equal(updateTicketRes.status, 200, 'Ticket resolution update succeeds');
  assert.ok(updateTicketData.success, 'Ticket updated');

  // -------------------------------------------------------------
  // Step 6: Admin Operational Cancellation Override
  // -------------------------------------------------------------
  const cancelOverrideRes = await fetch(base + '/api/admin/trips/cancel-override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify({
      orderId: b2bTrip.id,
      reason: 'Mutual merchant cancellation following mechanical incident'
    })
  });
  const cancelOverrideData = await cancelOverrideRes.json();
  assert.equal(cancelOverrideRes.status, 200, 'Trip cancellation override succeeds');
  assert.ok(cancelOverrideData.success, 'Cancel override success flag');
  assert.equal(cancelOverrideData.trip.status, 'CANCELLED', 'Trip status set to CANCELLED');
});
