const { test, expect } = require('@playwright/test');
const { configuredAdminUsers } = require('../../src/http/helpers');

async function browserHealth(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText || 'unknown'}`));
  return { consoleErrors, pageErrors, failedRequests };
}

async function visibleInputs(page) {
  return page.locator('input:visible, textarea:visible, select:visible').evaluateAll(elements => elements.map((element, index) => ({
    index, tag: element.tagName, type: element.getAttribute('type'), name: element.getAttribute('name'),
    placeholder: element.getAttribute('placeholder'), aria: element.getAttribute('aria-label'), value: element.value,
  })));
}

function configuredTestAdmins() {
  if (process.env.VAAYU_TEST_ADMIN_USERNAME && process.env.VAAYU_TEST_ADMIN_PASSWORD) {
    return [{
      username: process.env.VAAYU_TEST_ADMIN_USERNAME,
      password: process.env.VAAYU_TEST_ADMIN_PASSWORD,
      role: process.env.VAAYU_TEST_ADMIN_ROLE || 'ADMIN',
    }];
  }

  return configuredAdminUsers().map(admin => ({
    username: admin.username,
    password: admin.password,
    role: admin.role,
  }));
}

async function waitForCustomerOtp(page, phone) {
  const admins = configuredTestAdmins();
  expect(admins.length, 'Browser certification requires at least one valid configured admin account.').toBeGreaterThan(0);

  let loginBody = null;
  const attemptedRoles = [];
  for (const admin of admins) {
    const loginResponse = await page.request.post('/api/admin/login', { data: admin });
    const body = await loginResponse.json().catch(() => ({}));
    if (!loginResponse.ok() || !body.token) {
      attemptedRoles.push(`${admin.role}:login-${loginResponse.status()}`);
      continue;
    }

    const otpProbe = await page.request.get('/api/admin/otp/requests?app=CUSTOMER&limit=1', {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    if (!otpProbe.ok()) {
      attemptedRoles.push(`${admin.role}:otp-${otpProbe.status()}`);
      continue;
    }

    loginBody = body;
    break;
  }

  expect(loginBody, `No configured admin account can access the OTP console. Roles/statuses tested: ${attemptedRoles.join(', ')}`).not.toBeNull();

  const suffix = phone.replace(/\D/g, '').slice(-4);
  let latestRequests = [];
  let otp = null;
  await expect.poll(async () => {
    const response = await page.request.get('/api/admin/otp/requests?app=CUSTOMER&limit=100', {
      headers: { Authorization: `Bearer ${loginBody.token}` },
    });
    expect(response.ok(), `OTP console request failed with HTTP ${response.status()}`).toBeTruthy();
    const body = await response.json();
    latestRequests = Array.isArray(body.requests) ? body.requests : [];
    const match = latestRequests.find(request => String(request.maskedPhone || '').includes(suffix));
    otp = match?.code ? String(match.code) : null;
    return otp;
  }, { timeout: 8_000, message: `Customer OTP did not appear in the operator console for phone ending ${suffix}. Requests: ${JSON.stringify(latestRequests)}` }).not.toBeNull();

  expect(otp, `Customer OTP console returned no code. Requests: ${JSON.stringify(latestRequests)}`).toMatch(/^\d{6}$/);
  return otp;
}

test.describe('Customer interactive journey certification', () => {
  test('customer authentication and booking workspace are actually operable', async ({ page }) => {
    const health = await browserHealth(page);
    const phone = `9${Date.now().toString().slice(-9)}`;
    const customerName = `UI Certification ${Date.now()}`;

    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/VAAYU/i);

    const inputsBeforeAuth = await visibleInputs(page);
    expect(inputsBeforeAuth.length, 'Customer page rendered no interactive form controls').toBeGreaterThan(0);

    const phoneCandidates = page.locator('input:visible');
    const phoneCount = await phoneCandidates.count();
    let customerPhoneField = null;
    for (let i = 0; i < phoneCount; i += 1) {
      const candidate = phoneCandidates.nth(i);
      const placeholder = ((await candidate.getAttribute('placeholder')) || '').toLowerCase();
      const name = ((await candidate.getAttribute('name')) || '').toLowerCase();
      const aria = ((await candidate.getAttribute('aria-label')) || '').toLowerCase();
      if (placeholder.includes('mobile') || placeholder.includes('phone') || name.includes('phone') || name.includes('mobile') || aria.includes('phone') || aria.includes('mobile')) { customerPhoneField = candidate; break; }
    }
    expect(customerPhoneField, `Could not find the visible customer phone field. Visible inputs: ${JSON.stringify(inputsBeforeAuth)}`).not.toBeNull();
    await customerPhoneField.fill(phone);

    const textInputs = page.locator('input[type="text"]:visible');
    if (await textInputs.count()) {
      const firstText = textInputs.first();
      const placeholder = ((await firstText.getAttribute('placeholder')) || '').toLowerCase();
      const aria = ((await firstText.getAttribute('aria-label')) || '').toLowerCase();
      if (placeholder.includes('name') || aria.includes('name')) await firstText.fill(customerName);
    }

    // Submit the form that actually contains the customer phone field. This avoids accidentally
    // clicking a navigation/tab button that happens to contain words such as "Sign Up" or "Continue".
    const authForm = customerPhoneField.locator('xpath=ancestor::form[1]');
    expect(await authForm.count(), 'Customer phone field is not inside a usable authentication form').toBe(1);
    const sendOtp = authForm.getByRole('button').first();
    await expect(sendOtp, 'Customer authentication form has no usable OTP submission button').toBeVisible();
    const otpResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/auth/send-otp') && response.request().method() === 'POST',
      { timeout: 8_000 },
    );
    await sendOtp.click();
    const otpResponse = await otpResponsePromise;
    const otpResponseBody = await otpResponse.json().catch(() => ({}));
    expect(otpResponse.ok(), `Customer OTP request failed with HTTP ${otpResponse.status()}: ${JSON.stringify(otpResponseBody)}`).toBeTruthy();
    expect(otpResponseBody.success, `Customer OTP request returned success=false: ${JSON.stringify(otpResponseBody)}`).toBeTruthy();

    const otpFromConsole = await waitForCustomerOtp(page, phone);

    const otpCandidates = page.locator('input:visible');
    const otpCount = await otpCandidates.count();
    let otpField = null;
    for (let i = 0; i < otpCount; i += 1) {
      const candidate = otpCandidates.nth(i);
      const type = (await candidate.getAttribute('type')) || '';
      const placeholder = ((await candidate.getAttribute('placeholder')) || '').toLowerCase();
      const aria = ((await candidate.getAttribute('aria-label')) || '').toLowerCase();
      const maxLength = Number(await candidate.getAttribute('maxlength')) || 0;
      if ((type === 'tel' || type === 'number' || type === 'text') && (placeholder.includes('otp') || aria.includes('otp') || maxLength >= 4 || otpCount <= 3)) { otpField = candidate; break; }
    }
    expect(otpField, 'OTP screen rendered but no usable OTP input was found').not.toBeNull();
    await otpField.fill(otpFromConsole);

    const verifyOtp = page.getByRole('button', { name: /verify|continue|confirm|login/i }).first();
    await expect(verifyOtp, 'OTP screen has no usable verification button').toBeVisible();
    await verifyOtp.click();

    await expect.poll(async () => page.locator('body').innerText(), { timeout: 8_000 }).toMatch(/book|pickup|drop|vehicle|trip|wallet/i);

    const bookingControls = page.locator('input:visible, textarea:visible, select:visible, button:visible');
    expect(await bookingControls.count(), 'Authenticated customer workspace contains no usable controls').toBeGreaterThan(0);

    const textareas = page.locator('textarea:visible');
    const pickupInputs = page.locator('input:visible');
    if (await textareas.count()) await textareas.first().fill('');
    else if (await pickupInputs.count() >= 2) await pickupInputs.nth(0).fill('');

    const bodyAfterAuth = await page.locator('body').innerText();
    expect(bodyAfterAuth).not.toMatch(/uncaught TypeError|Cannot read properties of undefined/i);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/VAAYU/i);
    await expect(page.locator('body')).toContainText(/book|pickup|drop|vehicle|trip|wallet/i);

    expect(health.pageErrors, 'Customer journey emitted uncaught page errors').toEqual([]);
    expect(health.consoleErrors.filter(message => !/favicon|net::ERR_/i.test(message)), 'Customer journey emitted unexpected console errors').toEqual([]);
    expect(health.failedRequests.filter(entry => !entry.includes('favicon') && !entry.includes('fonts.googleapis.com') && !entry.includes('fonts.gstatic.com')), 'Customer journey has failed browser requests').toEqual([]);
  });
});
