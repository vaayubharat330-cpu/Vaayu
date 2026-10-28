const path = require('path');
const { defineConfig } = require('@playwright/test');

// Browser certification uses the same local admin configuration as the backend.
// Credentials stay in the developer's ignored repository-root .env and are never committed here.
try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
} catch (_) {
  // dotenv is optional for environments that inject variables directly.
}

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4000';
const configuredWorkers = Number.parseInt(process.env.PLAYWRIGHT_WORKERS || '6', 10);
const workers = Number.isFinite(configuredWorkers) && configuredWorkers > 0 ? configuredWorkers : 6;

module.exports = defineConfig({
  testDir: __dirname,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  workers,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list']],
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  outputDir: 'test-results',
});
