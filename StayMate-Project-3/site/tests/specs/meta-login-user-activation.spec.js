const { test, expect } = require('@playwright/test');
const { installBackendMock } = require('../helpers/mockBackend');

test('Instagram, Messenger, WhatsApp launch Meta login within the original click event', async ({ page }) => {
  await installBackendMock(page, {
    session: { user: { id: 'meta-test-user', email: 'hotel@example.com', created_at: new Date().toISOString() } },
    property: {
      property_id: 'meta-test-property',
      hotel_name: 'Meta Test Hotel',
      trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(),
      subscription_status: 'inactive',
    },
  });
  await page.addInitScript(() => {
    window.__metaCalls = [];
    // A fake native window.open lets tests observe the Meta SDK popup URL
    // without opening a real Facebook window.
    window.open = function() { return { close(){}, focus(){}, closed: false }; };
    window.__insideNativeClickEvent = false;
    document.addEventListener('click', () => { window.__insideNativeClickEvent = true; }, true);
    document.addEventListener('click', () => { window.__insideNativeClickEvent = false; });
  });
  await page.route('**/api/meta-config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      appId: '1482593830361119',
      pagesConfigId: 'pages-test-config',
      whatsappConfigId: 'whatsapp-test-config',
      graphVersion: 'v24.0',
    }),
  }));
  await page.route('https://connect.facebook.net/en_US/sdk.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: `
      window.FB = {
        init() {},
        login(callback, options) {
          const redirect = 'https://staticxx.facebook.com/x/connect/xd_arbiter/?version=46#cb=demo&domain=stayai.online&origin=https%3A%2F%2Fstayai.online%2Ftest&relation=opener';
          window.open('https://www.facebook.com/v24.0/dialog/oauth?redirect_uri=' + encodeURIComponent(redirect), 'fb_login');
          window.__metaCalls.push({
            configId: options.config_id,
            duringClick: window.__insideNativeClickEvent,
          });
          if (options.config_id === 'whatsapp-test-config') {
            window.dispatchEvent(new MessageEvent('message', {
              origin: 'https://www.facebook.com',
              data: JSON.stringify({
                type: 'WA_EMBEDDED_SIGNUP',
                data: { waba_id: 'demo-waba', phone_number_id: 'demo-phone' },
              }),
            }));
          }
          callback({ authResponse: { code: 'demo-oauth-code' } });
        },
      };
    `,
  }));
  const oauthRequests = [];
  await page.route('**/api/connect-meta-pages', (route) => {
    oauthRequests.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ pendingId: 'pending-demo', pages: [{ id: 'page-demo', name: 'Demo Page' }] }),
    });
  });
  await page.route('**/api/connect-meta-finalize', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }),
  }));
  await page.route('**/api/connect-whatsapp-embedded', (route) => {
    oauthRequests.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/cabinet/');
  await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/);
  await page.locator('.dash-tab[data-tab="channels"]').click();

  for (const button of ['connectMetaPagesIg', 'connectMetaPagesFb', 'connectWhatsappOAuth']) {
    await expect(page.locator('#' + button)).toBeEnabled();
    await page.locator('#' + button).click();
    await expect(page.locator('#' + button)).toBeEnabled();
  }

  const calls = await page.evaluate(() => window.__metaCalls);
  expect(calls).toEqual([
    { configId: 'pages-test-config', duringClick: true },
    { configId: 'pages-test-config', duringClick: true },
    { configId: 'whatsapp-test-config', duringClick: true },
  ]);
  expect(oauthRequests).toHaveLength(3);
  for (const item of oauthRequests) {
    expect(item.code).toBe('demo-oauth-code');
    expect(item.redirectUri).toBe('https://staticxx.facebook.com/x/connect/xd_arbiter/?version=46#cb=demo&domain=stayai.online&origin=https%3A%2F%2Fstayai.online%2Ftest&relation=opener');
  }
});
