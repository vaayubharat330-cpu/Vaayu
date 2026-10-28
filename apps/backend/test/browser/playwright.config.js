const path = require('path');
const { defineConfig } = require('@playwright/test');

// Browser certification should load the same local configuration as the backend.
// Prefer apps/backend/.env (the backend's local runtime configuration), then fall
// back to the repository-root .env for environments that keep shared settings there.
try {
  const backendEnv = path.resolve(__dirname, '../../.env');
  const rootEnv = path.resolve(__dirname, '../../../.env');
  require('dotenv').config({ path: backendEnv });
  require('dotenv').config({ path: rootEnv });
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
