const { test, expect } = require('@playwright/test');
const { installBackendMock } = require('../helpers/mockBackend');

test.describe('Dashboard — onboarding (new user, no property yet)', () => {
  test('onboarding form requires a hotel name', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: null,
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#onboardScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('#obSubmitTrial');
    await expect(page.locator('#obMsg')).toContainText(/назву/i);
  });

  test('choosing the free trial creates the property and goes to the card-linking gate', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: null,
    });
    await page.goto('/cabinet/');
    await page.fill('#obName', 'Test Hotel');
    await page.fill('#obAddress', 'Kyiv, Main St 1');
    await page.click('#obSubmitTrial');
    await expect(page.locator('#gateScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#gateTitle')).toContainText('картку');
  });

  test('choosing "pay now" also lands on the plan picker', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: null,
    });
    await page.goto('/cabinet/');
    await page.fill('#obName', 'Test Hotel');
    await page.click('#obSubmitPay');
    await expect(page.locator('#gateScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#gateTitle')).toContainText('тариф');
  });
});

test.describe('Dashboard — main screen (active trial)', () => {
  async function loginWithTrial(page) {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1',
        hotel_name: 'Test Hotel',
        address: 'Kyiv',
        trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(),
        subscription_status: 'inactive',
      },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
  }

  test('dashboard shows the hotel name and trial days-left hint', async ({ page }) => {
    await loginWithTrial(page);
    await expect(page.locator('#dashHotelName')).toContainText('Test Hotel');
    await expect(page.locator('#subHint')).toContainText(/Пробний період/);
  });

  test('rooms table starts empty (empty state) and "add room" adds a row', async ({ page }) => {
    await loginWithTrial(page);
    await expect(page.locator('#roomsBody tr')).toHaveCount(0);
    await page.click('#addRoomRow');
    await expect(page.locator('#roomsBody tr')).toHaveCount(1);
  });

  test('saving hotel info without changes does not error', async ({ page }) => {
    await loginWithTrial(page);
    await page.fill('#dashName', 'Renamed Hotel');
    await page.click('#dashSaveInfo');
    await expect(page.locator('#infoMsg')).toContainText(/Збережено/i, { timeout: 5000 });
  });

  test('"Змінити тариф / оплатити" reveals the plan picker (loading -> loaded state)', async ({ page }) => {
    await loginWithTrial(page);
    await expect(page.locator('#subPlanPicker')).toHaveClass(/hidden/);
    await page.click('#manageSubBtn');
    await expect(page.locator('#subPlanPicker')).not.toHaveClass(/hidden/);
  });
});

test.describe('Dashboard — gated access after trial ends', () => {
  test('expired trial + no subscription shows the payment gate, not the dashboard', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1',
        hotel_name: 'Test Hotel',
        trial_ends_at: new Date(Date.now() - 86400000).toISOString(), // yesterday
        subscription_status: 'inactive',
      },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#gateScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#dashScreen')).toHaveClass(/hidden/);
  });

  test('active paid subscription reaches the dashboard even past trial_ends_at', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1',
        hotel_name: 'Test Hotel',
        trial_ends_at: new Date(Date.now() - 86400000).toISOString(),
        subscription_status: 'active',
        subscription_plan: 'start',
        subscription_active_until: new Date(Date.now() + 20 * 86400000).toISOString(),
      },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
  });
});
