require('dotenv').config();
const assert = require('assert');

const base = 'http://127.0.0.1:4000';
const adminUsers = JSON.parse(process.env.VAAYU_ADMIN_USERS_JSON || '[]');

async function run() {
  console.log('--- 1. Admin Sign-In ---');
  const adminLoginRes = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: adminUsers[0].username,
      password: adminUsers[0].password
    })
  });
  const adminData = await adminLoginRes.json();
  assert.strictEqual(adminLoginRes.status, 200);
  assert.ok(adminData.token, 'Admin token received');
  const adminHeaders = { 'Authorization': `Bearer ${adminData.token}`, 'Content-Type': 'application/json' };
  console.log('Admin logged in:', adminData.adminUser.name);

  console.log('--- 2. Driver Self-Registration: Send OTP ---');
  const testPhone = `99${Math.floor(10000000 + Math.random() * 90000000)}`;
  const phoneSuffix = testPhone.slice(-4);
  const sendRegOtpRes = await fetch(`${base}/api/auth/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: testPhone, appType: 'DRIVER' })
  });
  const sendRegData = await sendRegOtpRes.json();
  console.log('Send Reg OTP response:', sendRegOtpRes.status, sendRegData);
  assert.strictEqual(sendRegOtpRes.status, 200);
  assert.strictEqual(sendRegData.success, true);

  console.log('--- 3. Fetch OTP from Admin Console ---');
  const otpInboxRes = await fetch(`${base}/api/admin/otp/requests`, { headers: adminHeaders });
  const otpInboxData = await otpInboxRes.json();
  assert.strictEqual(otpInboxRes.status, 200);
  const regChallenge = otpInboxData.requests.find(r => r.maskedPhone.endsWith(phoneSuffix) && r.status === 'PENDING');
  assert.ok(regChallenge, 'Challenge found in admin console');
  assert.ok(regChallenge.code, 'Challenge code is visible in console');
  console.log('Reg OTP Code:', regChallenge.code);

  console.log('--- 4. Verify Registration Phone ---');
  const verifyRegPhoneRes = await fetch(`${base}/api/driver/register/verify-phone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: testPhone, otp: regChallenge.code })
  });
  const verifyRegData = await verifyRegPhoneRes.json();
  console.log('Verify Reg Phone response:', verifyRegPhoneRes.status, verifyRegData);
  assert.strictEqual(verifyRegPhoneRes.status, 200);
  assert.ok(verifyRegData.verificationId, 'Verification ID obtained');

  console.log('--- 5. Submit Driver Application ---');
  const registerRes = await fetch(`${base}/api/driver/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Kiran Kumar Captain',
      phone: testPhone,
      vehicleId: 'v_2w',
      vehicleNumber: 'TS09UB9988',
      licenseNumber: 'TS092021008899',
      city: 'Hyderabad',
      verificationId: verifyRegData.verificationId
    })
  });
  const registerData = await registerRes.json();
  console.log('Application submission response:', registerRes.status, registerData);
  assert.strictEqual(registerRes.status, 201);
  const applicationId = registerData.application.id;

  console.log('--- 6. Admin Reviews & Approves Driver Application ---');
  const approveRes = await fetch(`${base}/api/admin/driver-applications/${encodeURIComponent(applicationId)}/decision`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ decision: 'APPROVE', note: 'All KYC & registration verified' })
  });
  const approveData = await approveRes.json();
  console.log('Admin Approval response:', approveRes.status, approveData);
  assert.strictEqual(approveRes.status, 200);
  assert.strictEqual(approveData.success, true);
  assert.ok(approveData.driver, 'Driver created on approval');
  console.log('Approved Driver ID:', approveData.driver.id, 'KYC Status:', approveData.driver.kycStatus);

  console.log('--- 7. Driver Immediately Requests Login OTP (Verifying No Cooldown or Limit Block) ---');
  const sendLoginOtpRes = await fetch(`${base}/api/auth/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: testPhone, appType: 'DRIVER' })
  });
  const sendLoginData = await sendLoginOtpRes.json();
  console.log('Send Login OTP response:', sendLoginOtpRes.status, sendLoginData);
  assert.strictEqual(sendLoginOtpRes.status, 200, 'Login OTP send must succeed immediately without 429');
  assert.strictEqual(sendLoginData.success, true);

  console.log('--- 8. Fetch Login OTP from Admin Console ---');
  const otpInbox2 = await (await fetch(`${base}/api/admin/otp/requests`, { headers: adminHeaders })).json();
  const loginChallenge = otpInbox2.requests.find(r => r.maskedPhone.endsWith(phoneSuffix) && r.status === 'PENDING');
  assert.ok(loginChallenge, 'Login challenge found in console');
  console.log('Login OTP Code:', loginChallenge.code);

  console.log('--- 9. Driver Verifies Login OTP ---');
  const verifyLoginRes = await fetch(`${base}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: testPhone, otp: loginChallenge.code, appType: 'DRIVER' })
  });
  const verifyLoginData = await verifyLoginRes.json();
  console.log('Verify Login response:', verifyLoginRes.status, verifyLoginData);
  assert.strictEqual(verifyLoginRes.status, 200, 'Login verify must succeed');
  assert.strictEqual(verifyLoginData.success, true);
  assert.strictEqual(verifyLoginData.user.role, 'DRIVER', 'User must be authenticated as DRIVER');
  assert.ok(verifyLoginData.token, 'Driver JWT token received');
  assert.ok(verifyLoginData.driverProfileId, 'Driver profile ID received');
  const driverToken = verifyLoginData.token;

  console.log('--- 10. Driver Sets Status to ONLINE ---');
  const statusRes = await fetch(`${base}/api/driver/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
    body: JSON.stringify({ driverId: verifyLoginData.driverProfileId, isOnline: true })
  });
  const statusData = await statusRes.json();
  console.log('Driver status response:', statusRes.status, statusData);
  assert.strictEqual(statusRes.status, 200);
  assert.strictEqual(statusData.success, true);

  console.log('\n======================================================');
  console.log('SUCCESS! Complete Driver Registration & Login Workflow Verified!');
  console.log('======================================================');
}

run().catch(err => {
  console.error('\nWORKFLOW TEST FAILED ✗:', err);
  process.exit(1);
});
