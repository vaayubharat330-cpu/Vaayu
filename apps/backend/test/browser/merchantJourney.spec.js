const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.VAAYU_TEST_BASE || 'http://127.0.0.1:4000';

function adminCredentials() {
  let records = [];
  try { records = JSON.parse(process.env.VAAYU_ADMIN_USERS_JSON || '[]'); } catch (_) {}
  const admin = records.find((record) => record && record.username && record.password);
  if (!admin) throw new Error('VAAYU_ADMIN_USERS_JSON must contain a certification admin');
  return admin;
}

async function readLatestConsoleOtp(request, phone) {
  const admin = adminCredentials();
  const login = await request.post(`${BASE_URL}/api/admin/login`, { data: { username: admin.username, password: admin.password } });
  expect(login.ok()).toBeTruthy();
  const loginBody = await login.json();
  expect(loginBody.success).toBeTruthy();
  const response = await request.get(`${BASE_URL}/api/admin/otp/requests?limit=50`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  const normalized = String(phone).replace(/\D/g, '');
  const match = (body.requests || []).find((entry) => {
    const entryPhone = String(entry.phone || entry.maskedPhone || '').replace(/\D/g, '');
    return entryPhone.endsWith(normalized.slice(-10)) && entry.code;
  });
  return match ? String(match.code) : null;
}

async function findPhoneInput(page) {
  const visibleInputs = page.locator('input:visible');
  const inputCount = await visibleInputs.count();
  for (let i = 0; i < inputCount; i += 1) {
    const input = visibleInputs.nth(i);
    const marker = [
      await input.getAttribute('placeholder'),
      await input.getAttribute('name'),
      await input.getAttribute('aria-label'),
      await input.getAttribute('autocomplete'),
      await input.getAttribute('inputmode'),
    ].filter(Boolean).join(' ');
    const type = ((await input.getAttribute('type')) || 'text').toLowerCase();
    const maxLength = Number(await input.getAttribute('maxlength'));
    if (/phone|mobile|contact number|telephone/i.test(marker) || type === 'tel' || /numeric|decimal/i.test(marker) || maxLength === 10) return input;
  }
  for (let i = 0; i < inputCount; i += 1) {
    const input = visibleInputs.nth(i);
    const type = ((await input.getAttribute('type')) || 'text').toLowerCase();
    const marker = [await input.getAttribute('placeholder'), await input.getAttribute('name'), await input.getAttribute('aria-label')].filter(Boolean).join(' ');
    if (type === 'text' && !/email|password|otp|code/i.test(marker)) return input;
  }
  return null;
}

async function fillSignupFields(page, phone) {
  const inputs = page.locator('input:visible');
  for (let i = 0; i < await inputs.count(); i += 1) {
    const input = inputs.nth(i);
    if (!(await input.isVisible())) continue;
    const type = ((await input.getAttribute('type')) || 'text').toLowerCase();
    const marker = [await input.getAttribute('placeholder'), await input.getAttribute('name'), await input.getAttribute('aria-label')].filter(Boolean).join(' ');
    if (/phone|mobile|telephone|contact number/i.test(marker) || type === 'tel') {
      await input.fill(phone);
    } else if (/business|company|merchant.*name|shop.*name/i.test(marker)) {
      await input.fill(`VAAYU Certification ${Date.now()}`);
    } else if (/contact.*name|owner|full.*name/i.test(marker)) {
      await input.fill('Certification Merchant');
    } else if (type === 'email' || /email/i.test(marker)) {
      await input.fill(`merchant.${Date.now()}@example.com`);
    } else if (/gst/i.test(marker)) {
      await input.fill('36ABCDE1234F1Z5');
    } else if (/address/i.test(marker)) {
      await input.fill('Hyderabad, Telangana');
    }
  }
}

test.describe('Merchant portal — interactive journey certification', () => {
  test('merchant registration, authentication and workspace are actually operable', async ({ page, request }) => {
    const pageErrors = [];
    const consoleErrors = [];
    const failedRequests = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()}`));

    await page.goto(`${BASE_URL}/merchant.html`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/VAAYU Enterprise Portal/i);

    const phone = `9${Date.now().toString().slice(-9)}`;
    await expect(page.locator('input:visible').first()).toBeVisible();

    const signupToggle = page.getByRole('button', { name: /sign\s*up|register|create.*merchant|new.*merchant/i }).first();
    if (await signupToggle.count()) await signupToggle.click();

    const phoneInput = await findPhoneInput(page);
    if (!phoneInput) throw new Error('Merchant phone input was not discovered');
    await phoneInput.fill(phone);
    await fillSignupFields(page, phone);

    // Registration has a dedicated OTP action. Use the exact accessible name so
    // this test can never accidentally click a generic Continue/Verify control.
    const sendOtpButton = page.getByRole('button', { name: /^Send Verification OTP$/i });
    await expect(sendOtpButton).toHaveCount(1);
    await expect(sendOtpButton).toBeVisible();
    await expect(sendOtpButton).toBeEnabled();

    const otpResponsePromise = page.waitForResponse(
      (response) => response.url().includes('/api/auth/send-otp') && response.request().method() === 'POST',
      { timeout: 8000 },
    );
    await sendOtpButton.click();
    const otpResponse = await otpResponsePromise;
    expect(otpResponse.ok()).toBeTruthy();
    expect((await otpResponse.json()).success).toBeTruthy();

    let otpField = null;
    for (let i = 0; i < await page.locator('input:visible').count(); i += 1) {
      const input = page.locator('input:visible').nth(i);
      const marker = `${await input.getAttribute('placeholder') || ''} ${await input.getAttribute('name') || ''} ${await input.getAttribute('aria-label') || ''}`;
      if (/otp|code/i.test(marker)) { otpField = input; break; }
    }
    if (!otpField) throw new Error('Merchant OTP input was not discovered after sending OTP');

    let otp = null;
    for (let attempt = 0; attempt < 10 && !otp; attempt += 1) {
      otp = await readLatestConsoleOtp(request, phone);
      if (!otp) await page.waitForTimeout(300);
    }
    if (!otp) throw new Error(`Merchant OTP did not appear for phone ending ${phone.slice(-4)}`);
    await otpField.fill(otp);

    const verifyButton = page.getByRole('button', { name: /verify|complete|register|create account|finish/i }).last();
    await expect(verifyButton).toBeVisible();
    await verifyButton.click();

    await expect(page.getByText(/dashboard|enterprise|orders|book.*delivery|merchant/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:visible').first()).toBeVisible();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/dashboard|enterprise|orders|book.*delivery|merchant/i).first()).toBeVisible({ timeout: 10000 });

    expect(pageErrors, `Uncaught page errors: ${pageErrors.join('\n')}`).toEqual([]);
    const unexpectedConsoleErrors = consoleErrors.filter((message) => !/favicon|leaflet/i.test(message));
    expect(unexpectedConsoleErrors, `Console errors: ${unexpectedConsoleErrors.join('\n')}`).toEqual([]);
    expect(failedRequests, `Failed requests: ${failedRequests.join('\n')}`).toEqual([]);
  });
});
