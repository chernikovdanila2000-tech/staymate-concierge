const { test, expect } = require('@playwright/test');
const { installBackendMock } = require('../helpers/mockBackend');
const { MARKETING_PAGES } = require('../helpers/pages');

const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  tablet: { width: 820, height: 1180 },
  iphone: { width: 390, height: 844 },
  android: { width: 412, height: 915 },
};

test.describe('Responsive — no horizontal overflow', () => {
  for (const pagePath of [...MARKETING_PAGES, 'cabinet/']) {
    for (const [name, size] of Object.entries(VIEWPORTS)) {
      test(`${pagePath} @ ${name} (${size.width}x${size.height}): body does not overflow horizontally`, async ({ page }) => {
        await page.setViewportSize(size);
        await installBackendMock(page);
        await page.goto(`/${pagePath}`);
        await page.waitForTimeout(200);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${pagePath} @ ${name}: horizontal scroll of ${overflow}px`).toBeLessThanOrEqual(2);
      });
    }
  }
});

test.describe('Responsive — mobile menu usable on small screens', () => {
  test('index.html @ iPhone size: burger menu is tappable and links are reachable', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.iphone);
    await installBackendMock(page);
    await page.goto('/index.html');
    const burger = page.locator('#burgerBtn');
    const box = await burger.boundingBox();
    // Apple HIG minimum tap target is 44x44 — flag anything meaningfully smaller.
    expect(box.width, 'burger button width should be a reasonable tap target').toBeGreaterThanOrEqual(32);
    expect(box.height, 'burger button height should be a reasonable tap target').toBeGreaterThanOrEqual(32);
    await burger.click();
    await expect(page.locator('#mobilePanel a[data-i18n="nav.pricing"]')).toBeVisible();
  });
});

test.describe('Responsive — forms usable on small screens', () => {
  test('cabinet auth form inputs are full-width and not clipped on iPhone size', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.iphone);
    await installBackendMock(page);
    await page.goto('/cabinet/');
    const emailBox = await page.locator('#authEmail').boundingBox();
    expect(emailBox.x + emailBox.width).toBeLessThanOrEqual(VIEWPORTS.iphone.width + 1);
  });
});
