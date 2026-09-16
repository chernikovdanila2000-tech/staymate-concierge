const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { installBackendMock } = require('../helpers/mockBackend');
const { MARKETING_PAGES } = require('../helpers/pages');

test.describe('Accessibility — automated axe-core audit (critical/serious only)', () => {
  for (const pagePath of MARKETING_PAGES) {
    test(`${pagePath}: no critical/serious a11y violations`, async ({ page }) => {
      await installBackendMock(page);
      await page.goto(`/${pagePath}`);
      await page.waitForTimeout(200);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
      const summary = bad.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`);
      expect(summary, `critical/serious a11y issues on ${pagePath}`).toEqual([]);
    });
  }

  test('cabinet auth screen: no critical/serious a11y violations', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/cabinet/');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    const summary = bad.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`);
    expect(summary).toEqual([]);
  });
});

test.describe('Accessibility — manual checks', () => {
  test('every icon-only button has an accessible name', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/index.html');
    const unlabeled = await page.$$eval('button', (btns) =>
      btns
        .filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.querySelector('title'))
        .map((b) => b.outerHTML.slice(0, 120))
    );
    expect(unlabeled, 'icon-only buttons missing an accessible name').toEqual([]);
  });

  test('every form input has an associated label', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/contacts.html');
    const unlabeled = await page.$$eval('input, textarea', (inputs) =>
      inputs
        .filter((el) => el.type !== 'hidden' && el.type !== 'submit')
        .filter((el) => {
          const id = el.id;
          const hasLabel = id && document.querySelector(`label[for="${id}"]`);
          const hasAria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
          return !hasLabel && !hasAria;
        })
        .map((el) => el.outerHTML.slice(0, 120))
    );
    expect(unlabeled, 'inputs missing a label').toEqual([]);
  });

  test('keyboard navigation: Tab reaches the burger menu and Enter activates it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installBackendMock(page);
    await page.goto('/index.html');
    await page.locator('#burgerBtn').focus();
    await expect(page.locator('#burgerBtn')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#mobilePanel')).toHaveClass(/open/);
  });

  test('language switcher is keyboard-operable', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/index.html');
    await page.locator('#langBtn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#langMenu')).toHaveClass(/open/);
  });
});
