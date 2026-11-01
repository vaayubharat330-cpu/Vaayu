const { test, expect } = require('@playwright/test');

// These pages deliberately share one disposable backend while remaining
// independent browser contexts. This is the foundation for cross-role flow
// certification: a defect in one surface must not be hidden by another.
const roles = [
  { role: 'customer', path: '/', root: '#root', bundle: '/built/index.js' },
  { role: 'driver', path: '/driver/', root: '#appViewport', bundle: '/driver/app.js' },
  { role: 'merchant', path: '/merchant.html', root: '#merchant-root', bundle: '/built/merchant.js' },
  { role: 'admin', path: '/admin.html', root: '#admin-root', bundle: '/built/admin.js' },
];

function unexpectedFailures(url) {
  return url.filter(value =>
    !value.includes('favicon') &&
    !value.includes('google-analytics') &&
    !value.includes('fonts.googleapis.com') &&
    !value.includes('fonts.gstatic.com')
  );
}

test('customer, driver, merchant and admin surfaces operate in parallel', async ({ browser, baseURL }) => {
  const contexts = await Promise.all(roles.map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map(context => context.newPage()));

  try {
    const observations = await Promise.all(pages.map(async (page, index) => {
      const role = roles[index];
      const consoleErrors = [];
      const pageErrors = [];
      const failedRequests = [];
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()}`));

      const response = await page.goto(role.path, { waitUntil: 'domcontentloaded' });
      const root = page.locator(role.root);
      await expect(root, `${role.role} root ${role.root} must be attached`).toBeAttached();
      await expect(root, `${role.role} root ${role.root} must become visible`).toBeVisible();

      const bundle = await page.request.get(role.bundle);
      const health = await page.request.get('/api/health');
      await page.waitForTimeout(750);

      return {
        role: role.role,
        status: response?.status() ?? null,
        bundleStatus: bundle.status(),
        healthStatus: health.status(),
        consoleErrors,
        pageErrors,
        failedRequests: unexpectedFailures(failedRequests),
      };
    }));

    for (const observation of observations) {
      expect(observation.status, `${observation.role} document failed`).toBe(200);
      expect(observation.bundleStatus, `${observation.role} bundle failed`).toBe(200);
      expect(observation.healthStatus, `${observation.role} cannot reach backend health`).toBe(200);
      expect(observation.pageErrors, `${observation.role} emitted page errors`).toEqual([]);
      expect(observation.consoleErrors, `${observation.role} emitted console errors`).toEqual([]);
      expect(observation.failedRequests, `${observation.role} emitted failed requests`).toEqual([]);
    }

    expect(observations.map(x => x.role)).toEqual(['customer', 'driver', 'merchant', 'admin']);
    expect(baseURL).toMatch(/^http/);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
