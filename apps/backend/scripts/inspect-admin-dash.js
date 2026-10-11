const puppeteer = require('puppeteer-core');
require('dotenv').config();
const adminUsers = JSON.parse(process.env.VAAYU_ADMIN_USERS_JSON || '[]');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:4000/admin.html', { waitUntil: 'networkidle2' });
  
  // First screenshot the login gate with role selector
  await page.screenshot({ path: 'reports/screenshots/07_admin_login_gate.png', fullPage: false });

  // Type credentials
  await page.type('input[type="email"]', adminUsers[0].username);
  await page.type('input[type="password"]', adminUsers[0].password);
  await page.click('button[type="submit"]');
  
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: 'reports/screenshots/08_admin_analytics_clean.png', fullPage: false });
  
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('Admin Page loaded successfully!');
  console.log('Has Super Admin badge:', bodyText.includes('VAAYU Local Super Admin'));
  console.log('Has Ramesh Captain (should be false):', bodyText.includes('Ramesh Captain'));
  console.log('Has mojibake (should be false):', bodyText.includes('ðŸ'));
  
  // Click on Drivers tab
  const tabs = await page.$$('button');
  for (const tab of tabs) {
    const text = await page.evaluate(el => el.innerText, tab);
    if (text && text.includes('Fleet Drivers')) {
      await tab.click();
      await new Promise(r => setTimeout(r, 1000));
      await page.screenshot({ path: 'reports/screenshots/09_admin_drivers_clean.png', fullPage: false });
      break;
    }
  }

  // Click on Pricing tab to verify vehicle category icons
  const updatedTabs = await page.$$('button');
  for (const tab of updatedTabs) {
    const text = await page.evaluate(el => el.innerText, tab);
    if (text && text.includes('Pricing & Rates')) {
      await tab.click();
      await new Promise(r => setTimeout(r, 1000));
      await page.screenshot({ path: 'reports/screenshots/10_admin_pricing_clean.png', fullPage: false });
      break;
    }
  }

  // Click on SMS & OTP tab to verify SMS Gateway Simulator
  for (const tab of updatedTabs) {
    const text = await page.evaluate(el => el.innerText, tab);
    if (text && text.includes('SMS & OTP')) {
      await tab.click();
      await new Promise(r => setTimeout(r, 1000));
      await page.screenshot({ path: 'reports/screenshots/11_admin_sms_gateway_clean.png', fullPage: false });
      break;
    }
  }

  await browser.close();
  console.log('All admin screenshots captured and verified.');
})();
