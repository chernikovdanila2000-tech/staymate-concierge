const { test, expect } = require('@playwright/test');
const { installBackendMock } = require('../helpers/mockBackend');
const { ALL_SITE_PAGES } = require('../helpers/pages');

test.describe('Navigation — every page loads', () => {
  for (const pagePath of ALL_SITE_PAGES) {
    test(`${pagePath} responds 200 and renders`, async ({ page }) => {
      await installBackendMock(page);
      const resp = await page.goto(`/${pagePath}`);
      expect(resp.status(), `${pagePath} should return 200`).toBe(200);
      // Redirect stubs bounce to cabinet/ immediately — just confirm that lands ok.
      await page.waitForLoadState('domcontentloaded');
    });
  }

  test('cabinet/ (trailing slash, index resolution) responds 200', async ({ page }) => {
    await installBackendMock(page);
    const resp = await page.goto('/cabinet/');
    expect(resp.status()).toBe(200);
  });
});

test.describe('Navigation — favicon (regression)', () => {
  // Reported: the tab icon showed up on most pages but not on the home
  // page. The <link rel="icon"> tags are identical on every page, but
  // some browsers (especially pinned/bookmarked tabs) probe /favicon.ico
  // at the domain root directly, bypassing the page's <link> tags — so a
  // missing root-level favicon.ico could leave exactly the home page (or
  // any page reached as a bare bookmark) without an icon.
  test('favicon.ico exists at the domain root and decodes as an image', async ({ page, baseURL }) => {
    const res = await page.request.get(baseURL + '/favicon.ico');
    expect(res.status()).toBe(200);
    const decoded = await page.evaluate((url) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    }), baseURL + '/favicon.ico');
    expect(decoded).toBe(true);
  });

  test('index.html declares the same favicon <link> tags as the other pages', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/index.html');
    const href = await page.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute('href');
    expect(href).toMatch(/^favicon\.svg(\?.*)?$/);
    const res = await page.request.get('/' + href);
    expect(res.status()).toBe(200);
  });

  // The explicit <link> favicons carry a ?v= query string so browsers/CDNs
  // that cached the old (broken/missing) favicon under the un-versioned URL
  // are forced to fetch fresh instead of reusing a stale cache entry tied
  // to the bare filename.
  test('favicon <link> hrefs are cache-busted with a version query string', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/index.html');
    for (const rel of ['icon', 'apple-touch-icon']) {
      const hrefs = await page.locator(`link[rel="${rel}"]`).evaluateAll((els) => els.map((el) => el.getAttribute('href')));
      for (const href of hrefs) {
        expect(href, `${rel} href should be cache-busted: ${href}`).toMatch(/\?v=\d+$/);
      }
    }
  });
});

test.describe('Navigation — internal links resolve (no dead links)', () => {
  for (const pagePath of ALL_SITE_PAGES) {
    test(`${pagePath}: internal <a href> links all resolve`, async ({ page, request }) => {
      await installBackendMock(page);
      await page.goto(`/${pagePath}`);
      const hrefs = await page.$$eval('a[href]', (as) =>
        as
          .map((a) => a.getAttribute('href'))
          .filter((h) => h && !h.startsWith('http') && !h.startsWith('mailto:') && !h.startsWith('tel:') && !h.startsWith('#') && h !== '/')
      );
      const unique = [...new Set(hrefs)];
      for (const href of unique) {
        const target = href.startsWith('/') ? href : `/${href}`;
        const resp = await request.get(target.replace(/\?.*$/, ''));
        expect(resp.status(), `${pagePath} -> ${href} should not 404`).toBeLessThan(400);
      }
    });
  }
});

test.describe('Navigation — mobile menu', () => {
  for (const pagePath of ['index.html', 'pricing.html']) {
    test(`${pagePath}: burger menu opens and closes on mobile`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await installBackendMock(page);
      await page.goto(`/${pagePath}`);
      const burger = page.locator('#burgerBtn');
      const panel = page.locator('#mobilePanel');
      await expect(burger).toBeVisible();
      await expect(panel).not.toHaveClass(/open/);
      await burger.click();
      await expect(panel).toHaveClass(/open/);
      // Panel should cover full viewport height, not the collapsed-to-header bug from before.
      const box = await panel.boundingBox();
      expect(box.height).toBeGreaterThan(400);
      await burger.click();
      await expect(panel).not.toHaveClass(/open/);
    });
  }
});

test.describe('Navigation — header scrolls away (not pinned)', () => {
  test('index.html: header is not position:sticky/fixed anymore', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/index.html');
    const position = await page.locator('header').evaluate((el) => getComputedStyle(el).position);
    expect(position).not.toBe('sticky');
    expect(position).not.toBe('fixed');
  });
});
