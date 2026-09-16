const { test, expect } = require('@playwright/test');
const { installBackendMock } = require('../helpers/mockBackend');

test.describe('Auth — protected page gating', () => {
  test('cabinet shows the auth screen (not the dashboard) when signed out', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/cabinet/');
    await expect(page.locator('#authScreen')).not.toHaveClass(/hidden/);
    await expect(page.locator('#dashScreen')).toHaveClass(/hidden/);
    await expect(page.locator('#onboardScreen')).toHaveClass(/hidden/);
  });
});

test.describe('Auth — register', () => {
  test('signup with immediate session redirects to the SAME origin, not an external domain (regression)', async ({ page, baseURL }) => {
    await installBackendMock(page);
    await page.goto('/cabinet/');
    await page.click('#switcherBtn'); // signin -> signup
    await page.fill('#authEmail', 'newuser@example.com');
    await page.fill('#authPassword', 'password123');

    // Registration must never navigate off the current host — a hardcoded
    // absolute production URL here would silently break every non-production
    // deploy (Netlify subdomain, preview URL, localhost).
    await Promise.all([page.waitForURL((url) => url.origin === new URL(baseURL).origin, { timeout: 5000 }), page.click('#authSubmit')]);
    expect(new URL(page.url()).origin).toBe(new URL(baseURL).origin);
  });

  test('signup without immediate session (email confirmation required) shows a check-your-email message', async ({ page }) => {
    // Mirrors Supabase's "Confirm email" toggle being ON: signUp() succeeds
    // but returns no session until the user clicks the link in their inbox.
    await installBackendMock(page, { requireEmailConfirmation: true });
    await page.goto('/cabinet/');
    await page.click('#switcherBtn');
    await page.fill('#authEmail', 'confirmme@example.com');
    await page.fill('#authPassword', 'password123');
    await page.click('#authSubmit');
    await expect(page.locator('#authMsg')).toContainText(/пошту|email/i, { timeout: 5000 });
  });

  test('signup with an already-registered, confirmed email shows a clear error (not silent "check your email")', async ({ page }) => {
    const state = await installBackendMock(page, {});
    await page.goto('/cabinet/');
    await page.evaluate((email) => {
      window.__qaState.users[email] = { password: 'password123', user: { id: 'u_existing', email, created_at: new Date().toISOString() } };
    }, 'existing@example.com');
    await page.click('#switcherBtn');
    await page.fill('#authEmail', 'existing@example.com');
    await page.fill('#authPassword', 'password123');
    await page.click('#authSubmit');
    await expect(page.locator('#authMsg')).toContainText('вже зареєстровано');
  });
});

test.describe('Auth — login', () => {
  test('valid credentials log in and reach the dashboard/onboarding', async ({ page }) => {
    const state = await installBackendMock(page);
    await page.goto('/cabinet/');
    await page.evaluate(() => {
      window.__qaState.users['user@example.com'] = { password: 'password123', user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } };
    });
    await page.fill('#authEmail', 'user@example.com');
    await page.fill('#authPassword', 'password123');
    await page.click('#authSubmit');
    await expect(page.locator('#onboardScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
  });

  test('invalid credentials show an error and stay on the auth screen', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/cabinet/');
    await page.fill('#authEmail', 'nobody@example.com');
    await page.fill('#authPassword', 'wrongpassword');
    await page.click('#authSubmit');
    await expect(page.locator('#authMsg')).toContainText(/Невірний|пароль/i);
    await expect(page.locator('#authScreen')).not.toHaveClass(/hidden/);
  });

  test('empty email/password shows a validation message, does not call Supabase', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/cabinet/');
    await page.click('#authSubmit');
    await expect(page.locator('#authMsg')).toContainText(/Заповніть/i);
  });
});

test.describe('Auth — logout', () => {
  test('logging out returns to the auth screen', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: { property_id: 'p1', hotel_name: 'Test Hotel', trial_ends_at: new Date(Date.now() + 3 * 86400000).toISOString(), subscription_status: 'inactive' },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.locator('#accountMenuBtn').click();
    // Both the desktop dropdown and the always-in-DOM mobile panel render
    // their own .acct-logout button — scope to the desktop one we just opened.
    await page.locator('#accountStatus .acct-logout').click();
    await expect(page.locator('#authScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
  });
});

test.describe('Auth — session persistence', () => {
  test('an existing session on load skips straight to the dashboard, no login prompt', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: { property_id: 'p1', hotel_name: 'Test Hotel', trial_ends_at: new Date(Date.now() + 3 * 86400000).toISOString(), subscription_status: 'inactive' },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#authScreen')).toHaveClass(/hidden/);
  });
});
