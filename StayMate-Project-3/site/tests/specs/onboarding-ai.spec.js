const { test, expect } = require('@playwright/test');
const { installBackendMock } = require('../helpers/mockBackend');

test.describe('AI onboarding — onboard.html chat', () => {
  test('shows a price card when the AI proposes one, and lets the owner accept it', async ({ page }) => {
    await page.route('**/api/onboarding-chat', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          reply: 'Дякую! Ось моя пропозиція:',
          profile: { business_name: 'Кавʼярня "Дім"' },
          priceProposal: { priceUah: 4999, justification: 'Малий потік клієнтів.' },
        }),
      })
    );

    await page.goto('/onboard.html');
    await page.fill('#obInput', 'У мене маленька кавʼярня');
    await page.click('#obSend');

    await expect(page.locator('.ob-price-card .amount')).toContainText('4 999');
    await expect(page.locator('.ob-price-card .why')).toContainText('Малий потік клієнтів.');

    await page.click('.ob-btn-accept');
    await page.waitForURL(/cabinet\/\?ob=/);
  });

  test('declining a price card dismisses it and lets the conversation continue', async ({ page }) => {
    await page.route('**/api/onboarding-chat', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          reply: 'Ось моя пропозиція:',
          profile: {},
          priceProposal: { priceUah: 9999, justification: 'Середній потік.' },
        }),
      })
    );

    await page.goto('/onboard.html');
    await page.fill('#obInput', 'Готель на 20 номерів');
    await page.click('#obSend');
    await expect(page.locator('.ob-price-card')).toBeVisible();

    await page.click('.ob-btn-decline');
    await expect(page.locator('.ob-price-card')).toHaveCount(0);
  });
});

test.describe('AI onboarding — cabinet confirmation screen', () => {
  test('a visitor arriving with an accepted AI quote skips the manual form and goes straight to the custom-price confirmation', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'owner@example.com', created_at: new Date().toISOString() } },
      property: null,
      onboardingProfile: {
        business_name: 'Кавʼярня "Дім"',
        business_type: 'кавʼярня',
        description: 'Невелика кавʼярня в центрі',
        proposedPriceUah: 4999,
        priceJustification: 'Малий потік клієнтів, 1-2 канали.',
      },
    });
    // A real wayforpay response would commit the redirect and tear down
    // this page's JS context (__qaState included) before the assertions
    // below can read it, so this override (takes priority over
    // installBackendMock's own route, registered after it) holds the
    // response just long enough to read state while the fetch is still
    // in flight, before the handler's window.location.href ever runs.
    let invoiceRequestBody = null;
    await page.route('**/api/create-subscription-invoice', async (route) => {
      invoiceRequestBody = JSON.parse(route.request().postData() || '{}');
      await new Promise((r) => setTimeout(r, 300));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ invoiceUrl: 'https://secure.wayforpay.com/mock-invoice', orderId: 'SUBMOCK', priceUah: invoiceRequestBody.customPriceUah }) });
    });

    await page.goto('/cabinet/?ob=sess-123');

    await expect(page.locator('#obAiScreen')).toBeVisible();
    await expect(page.locator('#onboardScreen')).toBeHidden();
    await expect(page.locator('#obAiBusinessName')).toHaveText('Кавʼярня "Дім"');
    await expect(page.locator('#obAiPrice')).toContainText('4 999');
    await expect(page.locator('#obAiJustification')).toContainText('Малий потік клієнтів');

    await page.click('#obAiConfirmBtn');
    // The property insert happens before the (deliberately slowed-down)
    // invoice fetch, so by the time that request lands, __qaState.property
    // is already set and still readable.
    await page.waitForFunction(() => window.__qaState.property !== null);
    const property = await page.evaluate(() => window.__qaState.property);

    expect(property.business_type).toBe('кавʼярня');
    expect(property.hotel_name).toBe('Кавʼярня "Дім"');
    await expect.poll(() => invoiceRequestBody).not.toBeNull();
    expect(invoiceRequestBody.plan).toBe('custom');
    expect(invoiceRequestBody.customPriceUah).toBe(4999);
  });

  test('an expired or missing onboarding session falls back to the normal manual onboarding form, not a dead end', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'owner@example.com', created_at: new Date().toISOString() } },
      property: null,
      onboardingProfile: null, // expired/never existed -> GET /api/onboarding-profile/* returns 404
    });

    await page.goto('/cabinet/?ob=expired-session');

    await expect(page.locator('#onboardScreen')).toBeVisible();
    await expect(page.locator('#obAiScreen')).toBeHidden();
  });
});
