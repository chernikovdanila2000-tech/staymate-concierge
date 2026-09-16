const { test, expect } = require('@playwright/test');
const { installBackendMock } = require('../helpers/mockBackend');

test('index.html loads and has a title', async ({ page }) => {
  await installBackendMock(page);
  await page.goto('/index.html');
  await expect(page).toHaveTitle(/StayAI/);
});
