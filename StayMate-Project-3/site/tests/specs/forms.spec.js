const { test, expect } = require('@playwright/test');
const { installBackendMock } = require('../helpers/mockBackend');

test.describe('Forms — contact form (contacts.html)', () => {
  test('required fields block submission via native HTML5 validation', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/contacts.html');
    const nameInput = page.locator('#cName');
    await page.click('button[data-i18n="form.submit"]');
    const isValid = await nameInput.evaluate((el) => el.checkValidity());
    expect(isValid, 'empty required field should be invalid').toBe(false);
  });

  test('valid submit shows a success toast and resets the form', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/contacts.html');
    await page.fill('#cName', 'Test User');
    await page.fill('#cEmail', 'test@example.com');
    await page.fill('#cMsg', 'Hello, testing the contact form.');
    await page.click('button[data-i18n="form.submit"]');
    await expect(page.locator('#toast')).toHaveClass(/on/);
    await expect(page.locator('#cName')).toHaveValue('');
  });

  // Reported: the form was purely cosmetic — it just showed a toast and
  // reset itself, never actually sending anything anywhere. It must now
  // really POST to the backend, which relays it to Telegram (@StayAI_support)
  // and, as a bonus channel, email.
  test('submitting actually POSTs the message to the backend', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/contacts.html');
    await page.fill('#cName', 'Test User');
    await page.fill('#cEmail', 'test@example.com');
    await page.fill('#cMsg', 'Hello, testing the contact form.');
    await page.click('button[data-i18n="form.submit"]');
    await expect(page.locator('#toast')).toHaveClass(/on/);
    const calls = await page.evaluate(() => window.__qaContactCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'Test User', email: 'test@example.com', message: 'Hello, testing the contact form.' });
  });

  test('a backend failure shows an error toast and keeps the form filled in (nothing lost)', async ({ page }) => {
    await installBackendMock(page, { failContactForm: true });
    await page.goto('/contacts.html');
    await page.fill('#cName', 'Test User');
    await page.fill('#cEmail', 'test@example.com');
    await page.fill('#cMsg', 'Hello, testing the contact form.');
    await page.click('button[data-i18n="form.submit"]');
    await expect(page.locator('#toast')).toHaveClass(/on/);
    await expect(page.locator('#toast')).toContainText(/telegram|email|пошт/i);
    await expect(page.locator('#cName')).toHaveValue('Test User');
    await expect(page.locator('button[data-i18n="form.submit"]')).toBeEnabled();
  });

  test('email and Telegram contact rows link to real, working addresses', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/contacts.html');
    const rows = page.locator('a.contact-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('href', 'mailto:stayaiproject@gmail.com');
    await expect(rows.nth(1)).toHaveAttribute('href', 'https://t.me/StayAI_support');
    await expect(rows.nth(1)).toHaveAttribute('target', '_blank');
  });
});

test.describe('Forms — cabinet auth form', () => {
  test('invalid email format is rejected by the input type=email', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/cabinet/');
    await page.fill('#authEmail', 'not-an-email');
    const isValid = await page.locator('#authEmail').evaluate((el) => el.checkValidity());
    expect(isValid).toBe(false);
  });

  test('submit button is disabled while a sign-in is in flight (no double-submit)', async ({ page }) => {
    await installBackendMock(page, { signInDelayMs: 300 });
    await page.goto('/cabinet/');
    await page.evaluate(() => {
      window.__qaState.users['dbl@example.com'] = { password: 'password123', user: { id: 'u1', email: 'dbl@example.com', created_at: new Date().toISOString() } };
    });
    await page.fill('#authEmail', 'dbl@example.com');
    await page.fill('#authPassword', 'password123');
    await page.click('#authSubmit');
    // While the (deliberately slow) sign-in is in flight, the button must be
    // disabled — otherwise a second rapid click fires a second request.
    await expect(page.locator('#authSubmit')).toBeDisabled();
    await page.click('#authSubmit', { force: true }); // simulate a click landing anyway
    await page.waitForTimeout(600);
    const calls = await page.evaluate(() => window.__qaSignInCalls);
    expect(calls, 'a disabled submit button being clicked again should not send a second request').toBe(1);
  });
});

test.describe('Forms — onboarding form (cabinet)', () => {
  test('empty hotel name blocks property creation with a clear error', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: null,
    });
    await page.goto('/cabinet/');
    await page.click('#obSubmitTrial');
    await expect(page.locator('#obMsg')).toHaveClass(/error/);
  });
});
