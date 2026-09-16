const { test } = require('@playwright/test');
const path = require('path');
const { installBackendMock } = require('../helpers/mockBackend');

const OUT = path.join(__dirname, '..', 'screenshots');

const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  iphone: { width: 390, height: 844 },
};

// These are reference screenshots for a human to eyeball, not pixel-diff
// assertions (there is no approved baseline yet) — see QA_REPORT_RU.md.
test.describe('Visual regression snapshots', () => {
  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    test(`index.html @ ${vpName}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await installBackendMock(page);
      await page.goto('/index.html');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `index-${vpName}.png`), fullPage: true });
    });

    test(`pricing.html @ ${vpName}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await installBackendMock(page);
      await page.goto('/pricing.html');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `pricing-${vpName}.png`), fullPage: true });
    });

    test(`cabinet auth screen @ ${vpName}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await installBackendMock(page);
      await page.goto('/cabinet/');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `cabinet-auth-${vpName}.png`), fullPage: true });
    });

    test(`cabinet dashboard (trial) @ ${vpName}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await installBackendMock(page, {
        session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
        property: { property_id: 'p1', hotel_name: 'Test Hotel', trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive' },
      });
      await page.goto('/cabinet/');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `cabinet-dashboard-${vpName}.png`), fullPage: true });
    });
  }

  test('account dropdown open (EN)', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'qa@example.com', created_at: new Date().toISOString() } },
      property: { property_id: 'p1', hotel_name: 'Test Hotel', trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive' },
    });
    await page.goto('/instructions.html');
    await page.evaluate(() => window.initAccountNav && window.initAccountNav());
    await page.waitForTimeout(200);
    await page.click('#langBtn');
    await page.click('#langMenu button[data-lang="en"]');
    await page.waitForTimeout(200);
    await page.locator('#accountMenuBtn').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'account-dropdown-en.png') });
  });
});
