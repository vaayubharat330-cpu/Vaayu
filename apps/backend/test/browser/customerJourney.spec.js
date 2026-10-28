const { test, expect } = require('@playwright/test');

async function browserHealth(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => {
    failedRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText || 'unknown'}`);
  });

  return { consoleErrors, pageErrors, failedRequests };
}

async function visibleInputs(page) {
  return page.locator('input:visible, textarea:visible, select:visible').evaluateAll(elements => elements.map((element, index) => ({
    index,
    tag: element.tagName,
    type: element.getAttribute('type'),
    name: element.getAttribute('name'),
    placeholder: element.getAttribute('placeholder'),
    aria: element.getAttribute('aria-label'),
    value: element.value,
  })));
}

test.describe('Customer interactive journey certification', () => {
  test('customer authentication and booking workspace are actually operable', async ({ page }) => {
    const health = await browserHealth(page);
    const phone = `9${Date.now().toString().slice(-9)}`;
    const customerName = `UI Certification ${Date.now()}`;
    let otpFromApi = null;

    page.on('response', async response => {
      if (!response.url().includes('/api/auth/send-otp') || response.request().method() !== 'POST') return;
      try {
        const body = await response.json();
        if (body?.success && body.demoOtp) otpFromApi = String(body.demoOtp);
      } catch (_) {
        // The assertion below will provide the actionable failure if the dev OTP is unavailable.
      }
    });

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
      if (placeholder.includes('mobile') || placeholder.includes('phone') || name.includes('phone') || name.includes('mobile') || aria.includes('phone') || aria.includes('mobile')) {
        customerPhoneField = candidate;
        break;
      }
    }

    expect(customerPhoneField, `Could not find the visible customer phone field. Visible inputs: ${JSON.stringify(inputsBeforeAuth)}`).not.toBeNull();
    await customerPhoneField.fill(phone);

    const textInputs = page.locator('input[type="text"]:visible');
    if (await textInputs.count()) {
      const firstText = textInputs.first();
      const placeholder = ((await firstText.getAttribute('placeholder')) || '').toLowerCase();
      const aria = ((await firstText.getAttribute('aria-label')) || '').toLowerCase();
      if (placeholder.includes('name') || aria.includes('name')) {
        await firstText.fill(customerName);
      }
    }

    const sendOtp = page.getByRole('button', { name: /send otp|continue|sign up|create account/i }).first();
    await expect(sendOtp, 'Customer signup form has no usable OTP submission button').toBeVisible();
    await sendOtp.click();

    await expect.poll(() => otpFromApi, {
      timeout: 5_000,
      message: 'Customer OTP request completed without exposing demoOtp to the browser test',
    }).not.toBeNull();

    const otpCandidates = page.locator('input:visible');
    const otpCount = await otpCandidates.count();
    let otpField = null;
    for (let i = 0; i < otpCount; i += 1) {
      const candidate = otpCandidates.nth(i);
      const type = (await candidate.getAttribute('type')) || '';
      const placeholder = ((await candidate.getAttribute('placeholder')) || '').toLowerCase();
      const aria = ((await candidate.getAttribute('aria-label')) || '').toLowerCase();
      const maxLength = Number(await candidate.getAttribute('maxlength')) || 0;
      if (type === 'tel' || type === 'number' || type === 'text') {
        if (placeholder.includes('otp') || aria.includes('otp') || maxLength >= 4 || otpCount <= 3) {
          otpField = candidate;
          break;
        }
      }
    }
    expect(otpField, 'OTP screen rendered but no usable OTP input was found').not.toBeNull();
    await otpField.fill(otpFromApi);

    const verifyOtp = page.getByRole('button', { name: /verify|continue|confirm|login/i }).first();
    await expect(verifyOtp, 'OTP screen has no usable verification button').toBeVisible();
    await verifyOtp.click();

    await expect.poll(async () => {
      return await page.locator('body').innerText();
    }, { timeout: 8_000 }).toMatch(/book|pickup|drop|vehicle|trip|wallet/i);

    const bookingControls = page.locator('input:visible, textarea:visible, select:visible, button:visible');
    expect(await bookingControls.count(), 'Authenticated customer workspace contains no usable controls').toBeGreaterThan(0);

    const textareas = page.locator('textarea:visible');
    const pickupInputs = page.locator('input:visible');
    if (await textareas.count()) {
      await textareas.first().fill('');
    } else if (await pickupInputs.count() >= 2) {
      await pickupInputs.nth(0).fill('');
    }

    const bodyAfterAuth = await page.locator('body').innerText();
    expect(bodyAfterAuth).not.toMatch(/uncaught TypeError|Cannot read properties of undefined/i);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/VAAYU/i);
    await expect(page.locator('body')).toContainText(/book|pickup|drop|vehicle|trip|wallet/i);

    expect(health.pageErrors, 'Customer journey emitted uncaught page errors').toEqual([]);
    const unexpectedConsoleErrors = health.consoleErrors.filter(message => !/favicon|net::ERR_/i.test(message));
    expect(unexpectedConsoleErrors, 'Customer journey emitted unexpected console errors').toEqual([]);

    const unexpectedFailures = health.failedRequests.filter(entry =>
      !entry.includes('favicon') &&
      !entry.includes('fonts.googleapis.com') &&
      !entry.includes('fonts.gstatic.com')
    );
    expect(unexpectedFailures, 'Customer journey has failed browser requests').toEqual([]);
  });
});
