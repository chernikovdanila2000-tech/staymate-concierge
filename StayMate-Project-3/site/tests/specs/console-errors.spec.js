const { test, expect } = require('@playwright/test');
const { installBackendMock } = require('../helpers/mockBackend');
const { MARKETING_PAGES } = require('../helpers/pages');

// Fonts/CDN hosts are unreachable inside this sandbox regardless of the app
// itself — that's an environment limitation, not a product bug, so we don't
// fail tests on these specific, expected failures. Everything else is real.
const IGNORED_URL_SUBSTRINGS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'wayforpay.com'];

function isIgnored(url) {
  return IGNORED_URL_SUBSTRINGS.some((s) => url.includes(s));
}

async function collectIssues(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Generic resource-load failures ("Failed to load resource: ...") carry
    // the failing URL in msg.location().url, not in the text — and every
    // real one is already reported (with full context) via the
    // requestfailed/response handlers below, so skip the duplicate here
    // rather than mis-filtering on text alone.
    if (/^Failed to load resource:/.test(msg.text()) && isIgnored(msg.location().url || '')) return;
    consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('requestfailed', (req) => {
    if (!isIgnored(req.url())) failedRequests.push(`${req.url()} — ${req.failure()?.errorText}`);
  });
  page.on('response', (resp) => {
    if (resp.status() >= 400 && !isIgnored(resp.url())) failedRequests.push(`${resp.url()} — HTTP ${resp.status()}`);
  });
  return { consoleErrors, pageErrors, failedRequests };
}

test.describe('Console / network errors — marketing pages', () => {
  for (const pagePath of MARKETING_PAGES) {
    test(`${pagePath}: no console errors, uncaught exceptions or failed requests`, async ({ page }) => {
      const issues = await collectIssues(page);
      await installBackendMock(page);
      await page.goto(`/${pagePath}`);
      await page.waitForTimeout(500);
      const badConsole = issues.consoleErrors.filter((t) => !isIgnored(t));
      expect(badConsole, `console errors on ${pagePath}`).toEqual([]);
      expect(issues.pageErrors, `uncaught exceptions on ${pagePath}`).toEqual([]);
      expect(issues.failedRequests, `failed network requests on ${pagePath}`).toEqual([]);
    });
  }
});

test.describe('Console / network errors — cabinet main flows', () => {
  test('cabinet auth screen: clean console', async ({ page }) => {
    const issues = await collectIssues(page);
    await installBackendMock(page);
    await page.goto('/cabinet/');
    await page.waitForTimeout(500);
    expect(issues.consoleErrors.filter((t) => !isIgnored(t))).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
  });

  test('cabinet dashboard (logged in, trial): clean console', async ({ page }) => {
    const issues = await collectIssues(page);
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: { property_id: 'p1', hotel_name: 'Test Hotel', trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive' },
    });
    await page.goto('/cabinet/');
    await page.waitForTimeout(700);
    expect(issues.consoleErrors.filter((t) => !isIgnored(t))).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
  });

  test('login with invalid credentials: clean console (error is shown in UI, not thrown)', async ({ page }) => {
    const issues = await collectIssues(page);
    await installBackendMock(page);
    await page.goto('/cabinet/');
    await page.fill('#authEmail', 'nobody@example.com');
    await page.fill('#authPassword', 'wrong');
    await page.click('#authSubmit');
    await page.waitForTimeout(500);
    expect(issues.consoleErrors.filter((t) => !isIgnored(t))).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
  });
});

test.describe('Broken images / assets', () => {
  for (const pagePath of MARKETING_PAGES) {
    test(`${pagePath}: no broken <img> elements`, async ({ page }) => {
      await installBackendMock(page);
      await page.goto(`/${pagePath}`);
      await page.waitForTimeout(300);
      const broken = await page.$$eval('img', (imgs) => imgs.filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.src));
      expect(broken, `broken images on ${pagePath}`).toEqual([]);
    });
  }
});
