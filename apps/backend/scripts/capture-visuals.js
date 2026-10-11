// Automated End-to-End Visual Inspection & Screenshot Engine
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME_PATH = process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome';

const BASE_URL = process.env.VAAYU_BASE_URL || 'http://127.0.0.1:4000';
const OUT_DIR = path.resolve(__dirname, '..', 'reports', 'screenshots');

const TARGETS = [
  {
    name: '01_customer_portal_desktop',
    url: `${BASE_URL}/index.html`,
    viewport: { width: 1440, height: 900 },
    waitForSelector: 'body'
  },
  {
    name: '02_customer_portal_mobile',
    url: `${BASE_URL}/index.html`,
    viewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
    waitForSelector: 'body'
  },
  {
    name: '03_merchant_b2b_cockpit_desktop',
    url: `${BASE_URL}/merchant.html`,
    viewport: { width: 1440, height: 900 },
    waitForSelector: 'body'
  },
  {
    name: '04_fleet_owner_portal_desktop',
    url: `${BASE_URL}/fleet.html`,
    viewport: { width: 1440, height: 900 },
    waitForSelector: 'body'
  },
  {
    name: '05_operations_admin_control_tower',
    url: `${BASE_URL}/admin.html`,
    viewport: { width: 1440, height: 900 },
    waitForSelector: 'body'
  },
  {
    name: '06_driver_partner_cockpit_phone',
    url: `${BASE_URL}/driver/index.html`,
    viewport: { width: 412, height: 915, isMobile: true, hasTouch: true },
    waitForSelector: 'body'
  },
  {
    name: '07_driver_partner_desktop_canvas',
    url: `${BASE_URL}/driver/index.html`,
    viewport: { width: 1440, height: 900 },
    waitForSelector: 'body'
  },
  {
    name: '08_public_live_tracking_mobile',
    url: `${BASE_URL}/public-track.html`,
    viewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
    waitForSelector: 'body'
  },
  {
    name: '09_otp_console_secure_admin',
    url: `${BASE_URL}/otp-console.html`,
    viewport: { width: 1280, height: 800 },
    waitForSelector: 'body'
  }
];

async function captureAll() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`====================================================`);
  console.log(`VAAYU Comprehensive Visual Screenshot Engine`);
  console.log(`Output Directory: ${OUT_DIR}`);
  console.log(`Target Base: ${BASE_URL}`);
  console.log(`====================================================\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  const results = [];

  for (const target of TARGETS) {
    const page = await browser.newPage();
    const consoleErrors = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });

    try {
      await page.setViewport(target.viewport);
      process.stdout.write(`Capturing ${target.name} ... `);

      await page.goto(target.url, { waitUntil: 'networkidle2', timeout: 15000 });
      if (target.waitForSelector) {
        await page.waitForSelector(target.waitForSelector, { timeout: 5000 }).catch(() => {});
      }

      // Small stabilization delay for maps/animations to settle
      await new Promise(r => setTimeout(r, 1500));

      const screenshotPath = path.join(OUT_DIR, `${target.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });

      console.log(`DONE ✓ [${target.viewport.width}x${target.viewport.height}]`);
      results.push({
        name: target.name,
        path: screenshotPath,
        errors: consoleErrors,
        success: true
      });
    } catch (err) {
      console.log(`FAILED ✗ (${err.message})`);
      results.push({
        name: target.name,
        error: err.message,
        success: false
      });
    } finally {
      await page.close();
    }
  }

  await browser.close();

  const summaryFile = path.join(OUT_DIR, 'visual_audit_summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nAudit Report Generated: ${summaryFile}`);
  return results;
}

captureAll().catch(e => {
  console.error('[Visual Engine Fatal Error]', e);
  process.exit(1);
});
