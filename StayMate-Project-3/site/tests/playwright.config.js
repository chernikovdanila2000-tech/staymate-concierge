// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const PORT = 8931;

module.exports = defineConfig({
  testDir: './specs',
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx http-server .. -p ${PORT} -s -c-1`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 30000,
  },
  // Single project: functional specs (nav/i18n/auth/forms/dashboard/a11y/
  // security) don't care about viewport. responsive.spec.js and
  // visual.spec.js set desktop/tablet/iPhone/Android viewports explicitly
  // per test case instead of relying on a project matrix — keeps the
  // 4-device requirement covered without a 4x runtime multiplier on every
  // other spec.
  projects: [{ name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
});
