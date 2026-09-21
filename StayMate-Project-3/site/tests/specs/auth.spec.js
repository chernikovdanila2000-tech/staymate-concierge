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

  // Reported bug: a transient network hiccup during sign-in shows a raw,
  // untranslated technical string ("Load failed" in Safari, "Failed to
  // fetch" in Chrome) straight from Supabase's fetch wrapper instead of a
  // readable message, and the user has no idea what went wrong.
  test('a network failure during sign-in shows a readable message, not a raw "Load failed"/"Failed to fetch"', async ({ page }) => {
    await installBackendMock(page, { signInError: 'Load failed' });
    await page.goto('/cabinet/');
    await page.fill('#authEmail', 'user@example.com');
    await page.fill('#authPassword', 'password123');
    await page.click('#authSubmit');
    await expect(page.locator('#authMsg')).not.toContainText('Load failed');
    await expect(page.locator('#authMsg')).toContainText(/з'єднат/i);
    // The submit button must not stay stuck disabled/darkened after the
    // failed attempt — a retry should work immediately.
    await expect(page.locator('#authSubmit')).toBeEnabled();
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

test.describe('Auth — reset/signup emails always link to the one canonical site (regression)', () => {
  // Reported: the password-reset email link sometimes opened a completely
  // different (stale) deployment of the site instead of the real one.
  // Root cause: redirectTo used window.location.href/origin — whichever
  // domain the person happened to be on when they clicked "Forgot
  // password?" (an old bookmark, a stale Netlify preview, etc.) is what got
  // baked into the email link. Fixed by hardcoding the canonical
  // https://stayai.online domain instead of reading it from the current page.
  test('cabinet sign-in screen "Forgot password?" always targets stayai.online, not the current origin', async ({ page }) => {
    await installBackendMock(page);
    await page.goto('/cabinet/');
    await page.fill('#authEmail', 'user@example.com');
    await page.click('#forgotBtn');
    const calls = await page.evaluate(() => window.__qaResetPasswordCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].redirectTo).toBe('https://stayai.online/cabinet/');
  });

  test('cabinet account-dropdown "Forgot password?" also targets stayai.online', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: { property_id: 'p1', hotel_name: 'Test Hotel', trial_ends_at: new Date(Date.now() + 3 * 86400000).toISOString(), subscription_status: 'inactive' },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.locator('#accountMenuBtn').click();
    await page.locator('#accountStatus .acct-forgot-pw').click();
    const calls = await page.evaluate(() => window.__qaResetPasswordCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].redirectTo).toBe('https://stayai.online/cabinet/');
  });

  test('marketing-page "Forgot password?" (account dropdown) also targets stayai.online', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
    });
    await page.goto('/index.html');
    await page.click('#accountMenuBtn');
    await page.locator('.acct-forgot-pw').click();
    const calls = await page.evaluate(() => window.__qaResetPasswordCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].redirectTo).toBe('https://stayai.online/cabinet/');
  });

  test('signup confirmation email also targets stayai.online, not the current origin', async ({ page }) => {
    await installBackendMock(page, { requireEmailConfirmation: true });
    await page.goto('/cabinet/');
    await page.click('#switcherBtn');
    await page.fill('#authEmail', 'newuser@example.com');
    await page.fill('#authPassword', 'password123');
    await page.click('#authSubmit');
    await expect(page.locator('#authMsg')).toContainText(/пошту|email/i, { timeout: 5000 });
    const calls = await page.evaluate(() => window.__qaSignUpCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].emailRedirectTo).toBe('https://stayai.online/cabinet/');
  });
});

test.describe('Auth — password recovery link (regression)', () => {
  // Reported bug: opening the "reset password" link from the email — which,
  // per Supabase's recovery flow, lands on the page with a #...&type=recovery
  // hash and an already-active session — skipped the "set a new password"
  // form entirely and dropped the person straight into the dashboard, as if
  // they'd just logged in normally. Root cause: the startup block only knew
  // to special-case a signup-confirmation link (type=signup in the hash),
  // not a recovery one, so it saw "there's a session" and called
  // afterLogin() before the async PASSWORD_RECOVERY auth event had a chance
  // to show the reset form — a race that afterLogin() usually won.
  test('a recovery link shows the new-password form, not the dashboard', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: { property_id: 'p1', hotel_name: 'Test Hotel', trial_ends_at: new Date(Date.now() + 3 * 86400000).toISOString(), subscription_status: 'inactive' },
    });
    await page.goto('/cabinet/#access_token=fake&refresh_token=fake&type=recovery');
    await expect(page.locator('#resetScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#dashScreen')).toHaveClass(/hidden/);
    await expect(page.locator('#onboardScreen')).toHaveClass(/hidden/);
    await expect(page.locator('#gateScreen')).toHaveClass(/hidden/);
  });

  test('a recovery link for a brand-new user (no property yet) still shows the reset form, not onboarding', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: null,
    });
    await page.goto('/cabinet/#access_token=fake&refresh_token=fake&type=recovery');
    await expect(page.locator('#resetScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#onboardScreen')).toHaveClass(/hidden/);
  });

  test('a normal visit (no recovery hash) is unaffected — still goes straight to the dashboard', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: { property_id: 'p1', hotel_name: 'Test Hotel', trial_ends_at: new Date(Date.now() + 3 * 86400000).toISOString(), subscription_status: 'inactive' },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#resetScreen')).toHaveClass(/hidden/);
  });
});
