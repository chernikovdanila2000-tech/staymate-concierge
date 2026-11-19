const { test, expect } = require('@playwright/test');
const { installBackendMock } = require('../helpers/mockBackend');

const reviewUser = {
  id: 'separate-meta-reviewer',
  email: 'reviewer@example.com',
  created_at: new Date().toISOString(),
  app_metadata: {
    meta_review_property_id: 'test-hotel',
    meta_review_expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  },
};

test('a separate Meta reviewer sees connected channel status without managing connections', async ({ page }) => {
  await installBackendMock(page, { session: { user: reviewUser }, property: null });
  const requested = [];
  await page.route('**/api/meta-review/bootstrap?**', route => {
    requested.push(route.request().headers().authorization);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        reviewOnly: true,
        property: {
          property_id: 'test-hotel',
          hotel_name: 'Test hotel',
          subscription_status: 'trial',
          trial_ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
          business_type: 'hospitality',
        },
        channels: [
          { channel_type: 'instagram', connected: true, status: 'connected' },
          { channel_type: 'messenger', connected: true, status: 'connected' },
        ],
      }),
    });
  });

  await page.goto('/cabinet/');
  await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/);
  await expect(page.locator('#dashHotelName')).toHaveText('Test hotel');
  await expect(page.locator('#langBtnLabel')).toHaveText('EN');
  await expect(page.locator('.dash-tab[data-tab="overview"]')).toBeHidden();
  await expect(page.locator('#tabOverview')).toBeHidden();
  await expect(page.locator('#manageSubBtn')).toBeHidden();
  await expect(page.locator('.dash-tab[data-tab="channels"]')).toHaveClass(/active/);
  await expect(page.locator('#tabChannels')).toBeVisible();
  await expect(page.locator('.channel-card[data-channel="telegram"]')).toBeHidden();
  await expect(page.locator('.channel-card[data-channel="whatsapp"]')).toBeHidden();
  await expect(page.locator('.channel-card[data-channel="instagram"] .channel-head')).toBeVisible();
  await expect(page.locator('.channel-card[data-channel="messenger"] .channel-head')).toBeVisible();
  await expect(page.locator('#connectMetaPagesIg')).toBeHidden();
  await expect(page.locator('#connectMetaPagesIg')).toBeDisabled();
  await expect(page.locator('#connectMetaPagesFb')).toBeDisabled();
  await expect(page.locator('#disconnectInstagram')).toBeDisabled();
  await expect(page.locator('#disconnectMessenger')).toBeDisabled();
  await expect(page.locator('.dash-tab[data-tab="bookings"]')).toHaveClass(/hidden/);
  expect(requested.length).toBeGreaterThan(0);
  expect(requested.every(header => header && header.startsWith('Bearer '))).toBe(true);
});

test('review grant failure does not create or overwrite a property', async ({ page }) => {
  await installBackendMock(page, { session: { user: reviewUser }, property: null });
  await page.route('**/api/meta-review/bootstrap?**', route => route.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Review grant expired' }),
  }));
  await page.goto('/cabinet/');
  await expect(page.locator('#loadingErrorBlock')).not.toHaveClass(/hidden/);
  await expect(page.locator('#onboardScreen')).toHaveClass(/hidden/);
});

test('Meta SDK readiness cannot unlock controls after reviewer dashboard opens', async ({ page }) => {
  let releaseMetaConfig;
  const waitForReview = new Promise(resolve => { releaseMetaConfig = resolve; });
  await installBackendMock(page, { session: { user: reviewUser }, property: null });
  await page.route('**/api/meta-review/bootstrap?**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      reviewOnly: true,
      property: {
        property_id: 'test-hotel',
        hotel_name: 'Test hotel',
        subscription_status: 'trial',
        trial_ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
        business_type: 'hospitality',
      },
      channels: [
        { channel_type: 'instagram', connected: true, status: 'connected' },
        { channel_type: 'messenger', connected: true, status: 'connected' },
      ],
    }),
  }));
  await page.route('**/api/meta-config', async route => {
    await waitForReview;
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ appId: 'meta-review-test' }),
    });
  });
  await page.route('https://connect.facebook.net/en_US/sdk.js', route => route.fulfill({
    status: 200, contentType: 'application/javascript',
    body: 'window.FB = { init() { window.__metaSdkReady = true; } };',
  }));
  await page.goto('/cabinet/');
  await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/);
  await expect(page.locator('#connectMetaPagesIg')).toBeDisabled();
  releaseMetaConfig();
  await expect.poll(() => page.evaluate(() => window.__metaSdkReady === true)).toBe(true);
  for (const id of ['connectMetaPagesIg', 'connectMetaPagesFb', 'connectWhatsappOAuth', 'connectWhatsappBusinessOAuth']) {
    await expect(page.locator('#' + id)).toBeDisabled();
  }
});
