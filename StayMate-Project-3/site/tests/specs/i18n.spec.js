const { test, expect } = require('@playwright/test');
const { installBackendMock } = require('../helpers/mockBackend');
const { MARKETING_PAGES, ALL_SITE_PAGES, LANGS } = require('../helpers/pages');

const CYRILLIC = /[Ѐ-ӿ]/;

async function switchLang(page, lang) {
  await page.click('#langBtn');
  await page.click(`#langMenu button[data-lang="${lang}"]`);
  await page.waitForTimeout(150);
}

test.describe('i18n — switching updates every translated element, no leftover language', () => {
  for (const pagePath of MARKETING_PAGES) {
    test(`${pagePath}: switching to EN leaves no Cyrillic in data-i18n elements`, async ({ page }) => {
      await installBackendMock(page);
      await page.goto(`/${pagePath}`);
      await switchLang(page, 'en');
      const leftoverCyrillic = await page.$$eval('[data-i18n]', (els) =>
        els
          .filter((el) => /[Ѐ-ӿ]/.test(el.textContent || ''))
          .map((el) => ({ key: el.getAttribute('data-i18n'), text: el.textContent.trim() }))
      );
      expect(leftoverCyrillic, `Elements still showing Cyrillic after switching to EN on ${pagePath}`).toEqual([]);
    });

    test(`${pagePath}: langBtnLabel reflects selected language`, async ({ page }) => {
      await installBackendMock(page);
      await page.goto(`/${pagePath}`);
      for (const lang of LANGS) {
        await switchLang(page, lang);
        await expect(page.locator('#langBtnLabel')).toHaveText(lang.toUpperCase());
      }
    });
  }
});

test.describe('i18n — language persists across navigation and reload', () => {
  test('setting EN on index.html persists to pricing.html', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/index.html');
    await switchLang(page, 'en');
    await page.goto('/pricing.html');
    await expect(page.locator('#langBtnLabel')).toHaveText('EN');
    const homeLink = page.locator('.nav-links a[data-i18n="nav.home"]');
    await expect(homeLink).toHaveText('Home');
  });

  test('language persists after a full page reload', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/index.html');
    await switchLang(page, 'en');
    await page.reload();
    await expect(page.locator('#langBtnLabel')).toHaveText('EN');
  });
});

test.describe('i18n — Russian removed site-wide (regression)', () => {
  for (const pagePath of ALL_SITE_PAGES) {
    test(`${pagePath}: language switcher has no Russian option`, async ({ page }) => {
      await installBackendMock(page);
      await page.goto(`/${pagePath}`);
      await expect(page.locator('#langMenu button[data-lang="ru"]')).toHaveCount(0);
      await expect(page.locator('#langMenu button')).toHaveCount(2); // uk + en only
    });
  }

  test('cabinet language switcher has no Russian option', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: { property_id: 'p1', hotel_name: 'Test Hotel', trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive' },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#langMenu button[data-lang="ru"]')).toHaveCount(0);
    await expect(page.locator('#langMenu button')).toHaveCount(2);
  });

  test('a stale stayMateLang=ru from before the removal falls back to Ukrainian, not a broken state', async ({ page }) => {
    await installBackendMock(page);
    await page.addInitScript(() => { try { localStorage.setItem('stayMateLang', 'ru'); } catch (e) {} });
    await page.goto('/index.html');
    await expect(page.locator('#langBtnLabel')).toHaveText('UK');
    await expect(page.locator('.nav-links a[data-i18n="nav.home"]')).toHaveText('Головна');
  });
});

test.describe('i18n — account dropdown re-translates on language switch (regression)', () => {
  test('cabinet nav dropdown on a marketing page updates fully when language changes', async ({ page }) => {
    const state = await installBackendMock(page);
    state.session = null;
    await page.goto('/instructions.html');
    // Simulate a signed-in user by writing directly into the mock's state and
    // re-triggering the nav render (mirrors what a real sign-in would do).
    await page.evaluate(() => {
      window.__qaState.session = { user: { id: 'u1', email: 'qa@example.com' } };
      window.__qaState.property = { trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString() };
    });
    await page.evaluate(() => window.initAccountNav && window.initAccountNav());
    await page.waitForTimeout(200);
    await expect(page.locator('#accountDropdown')).toContainText('Підписка');

    await switchLang(page, 'en');
    await expect(page.locator('#accountDropdown')).toContainText('Subscription');
    await expect(page.locator('#accountDropdown')).toContainText('Forgot password?');
    const stillUkrainian = await page.locator('#accountDropdown').evaluate((el) => /[Ѐ-ӿ]/.test(el.textContent || ''));
    expect(stillUkrainian, 'account dropdown should have no Ukrainian text left after switching to EN').toBe(false);
  });

  // Reported bug: the marketing-site header dropdown only ever showed
  // Email + Subscription, unlike the cabinet's dropdown which also shows
  // "Дата реєстрації" — the registration date was effectively only visible
  // to someone who opened the dropdown from inside the cabinet.
  test('marketing-site header dropdown shows the registration date row too (parity with cabinet)', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date(Date.now() - 5 * 86400000).toISOString() } },
      property: { property_id: 'p1', hotel_name: 'Test Hotel', subscription_status: 'active', subscription_plan: 'pro', subscription_active_until: new Date(Date.now() + 28 * 86400000).toISOString() },
    });
    await page.goto('/index.html');
    await page.click('#accountMenuBtn');
    await expect(page.locator('#accountDropdown')).toContainText('Дата реєстрації');
    const rows = page.locator('#accountDropdown .acct-row');
    await expect(rows).toHaveCount(3); // Email, Дата реєстрації, Підписка
  });

  // Reported: the "Forgot password?" (a <button>) and "Personal cabinet"
  // (an <a>) dropdown actions looked mismatched in size — same padding in
  // CSS, but a plain <button> doesn't inherit the page's line-height the
  // way an <a> does, so the button rendered visibly shorter.
  test('Forgot password? and Personal cabinet dropdown buttons render at the same size', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: { property_id: 'p1', hotel_name: 'Test Hotel', subscription_status: 'active', subscription_plan: 'pro', subscription_active_until: new Date(Date.now() + 28 * 86400000).toISOString() },
    });
    await page.goto('/index.html');
    await page.click('#accountMenuBtn');
    const pw = await page.locator('.acct-forgot-pw').boundingBox();
    const cab = await page.locator('.acct-cabinet-link').boundingBox();
    expect(Math.abs(pw.width - cab.width)).toBeLessThan(1);
    expect(Math.abs(pw.height - cab.height)).toBeLessThan(1);
  });
});

test.describe('i18n — browser tab title follows the language switcher (regression)', () => {
  // Reported bug: the <title> tag was hardcoded Ukrainian and never touched
  // by applyI18n(), so switching the on-page language to EN left the browser
  // tab showing the Ukrainian title.
  test('index.html: tab title switches to English, and back to Ukrainian', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/index.html');
    await expect(page).toHaveTitle(/ІІ-адміністратор/);
    await switchLang(page, 'en');
    await expect(page).toHaveTitle('StayAI — AI front-desk for apartments');
    const stillCyrillic = await page.title();
    expect(CYRILLIC.test(stillCyrillic), `tab title still has Cyrillic after switching to EN: "${stillCyrillic}"`).toBe(false);
    await switchLang(page, 'uk');
    await expect(page).toHaveTitle('StayAI — ІІ-адміністратор для апартаментів');
  });

  test('pricing.html: tab title switches with the language too, not just index.html', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/pricing.html');
    await switchLang(page, 'en');
    await expect(page).toHaveTitle('StayAI — Pricing');
  });

  test('cabinet: tab title switches to English', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: { property_id: 'p1', hotel_name: 'Test Hotel', trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive' },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await switchLang(page, 'en');
    await expect(page).toHaveTitle('StayAI — hotel dashboard');
  });
});
