const { test, expect } = require('@playwright/test');

const surfaces = [
  { name: 'customer', path: '/', root: '#root', script: '/built/index.js' },
  { name: 'merchant', path: '/merchant.html', root: '#merchant-root', script: '/built/merchant.js' },
  { name: 'recipient tracking', path: '/public-track.html', root: '#public-track-root', script: '/built/public-track.js' },
  { name: 'admin', path: '/admin.html', root: '#admin-root', script: '/built/admin.js' },
  { name: 'driver', path: '/driver/', root: '#appViewport', script: '/driver/app.js' },
  { name: 'OTP console', path: '/otp-console.html', root: null, script: '/otp-console.js' },
];

async function captureBrowserHealth(page) {
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

for (const surface of surfaces) {
  test(`${surface.name} surface boots without application errors`, async ({ page }) => {
    const health = await captureBrowserHealth(page);
    const response = await page.goto(surface.path, { waitUntil: 'domcontentloaded' });

    expect(response, `${surface.name} did not return an HTTP response`).not.toBeNull();
    expect(response.status(), `${surface.name} returned an unexpected HTTP status`).toBe(200);

    await expect(page).toHaveTitle(/VAAYU/i);

    if (surface.root) {
      await expect(page.locator(surface.root)).toBeAttached();
    }

    const scriptResponse = await page.request.get(surface.script);
    expect(scriptResponse.status(), `${surface.name} bundle ${surface.script} is unavailable`).toBe(200);

    const tailwindLinks = await page.locator('link[href*="tailwind"]').count();
    expect(tailwindLinks, `${surface.name} should expose its local compiled Tailwind stylesheet`).toBeGreaterThan(0);

    await page.waitForTimeout(750);

    expect(health.pageErrors, `${surface.name} emitted uncaught page errors`).toEqual([]);
    expect(health.consoleErrors, `${surface.name} emitted console errors`).toEqual([]);

    const unexpectedFailures = health.failedRequests.filter(url =>
      !url.includes('favicon') &&
      !url.includes('google-analytics') &&
      !url.includes('fonts.googleapis.com') &&
      !url.includes('fonts.gstatic.com')
    );
    expect(unexpectedFailures, `${surface.name} has failed browser requests`).toEqual([]);
  });
}

test('customer portal uses local Tailwind instead of the Tailwind CDN', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const tailwindHref = await page.locator('link[href*="tailwind"]').first().getAttribute('href');
  expect(tailwindHref).toBe('/built/tailwind.css');

  const cdnTailwindScripts = await page.locator('script[src*="cdn.tailwindcss.com"]').count();
  expect(cdnTailwindScripts).toBe(0);

  const bodyBackground = await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor);
  expect(bodyBackground).not.toBe('rgba(0, 0, 0, 0)');
});

test('all core portal documents expose their expected local bundles', async ({ request }) => {
  for (const surface of surfaces) {
    const documentResponse = await request.get(surface.path);
    expect(documentResponse.status(), `${surface.name} document is unavailable`).toBe(200);

    const html = await documentResponse.text();
    expect(html).toContain(surface.script);
    if (surface.name !== 'OTP console') {
      expect(html).toContain('/built/tailwind.css');
    }
  }
});
