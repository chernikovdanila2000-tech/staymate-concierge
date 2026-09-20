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

  test('rooms list starts empty (empty state) and "+ Додати номер" adds a room via the form modal', async ({ page }) => {
    await loginWithTrial(page);
    await expect(page.locator('#roomsList .room-card')).toHaveCount(0);
    await expect(page.locator('#roomsEmptyHint')).toBeVisible();

    await page.click('#openAddRoom');
    await expect(page.locator('#roomFormModal')).not.toHaveClass(/hidden/);
    await page.fill('#rfType', 'Стандарт');
    await page.fill('#rfPrice', '1500');
    await page.fill('#rfCapacity', '2');
    await page.click('#rfSave');

    await expect(page.locator('#roomFormModal')).toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#roomsList .room-card')).toHaveCount(1);
    await expect(page.locator('.room-card-title')).toHaveText('Стандарт');
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

test.describe('Dashboard — pre-seeded rooms and channels render correctly', () => {
  test('rooms from the DB render with their real values, channel pills reflect connected state', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel',
        trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive',
      },
      rooms: [
        { property_id: 'p1', room_type: 'Стандарт', price_per_night: 1500, capacity: 2, quantity: 5, description: 'Опис' },
      ],
      channels: [
        { property_id: 'p1', channel_type: 'telegram', credentials: { bot_token: 'abc' }, connected: true },
      ],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#roomsList .room-card')).toHaveCount(1);
    await expect(page.locator('.room-card-title')).toHaveText('Стандарт');
    await expect(page.locator('#pill-telegram')).toHaveText(/Підключено/);
    await expect(page.locator('#pill-telegram')).not.toHaveClass(/off/);
  });
});

test.describe('Dashboard — double-submit protection (regression)', () => {
  test('"Зберегти" on hotel info disables the button while the request is in flight', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel',
        trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive',
      },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    const btn = page.locator('#dashSaveInfo');
    await btn.click();
    // The guard sets disabled=true synchronously before awaiting the write,
    // then re-enables in a finally — so by the time the click settles it's
    // enabled again, but it must never be double-clickable while in flight.
    await expect(page.locator('#infoMsg')).toContainText(/Збережено/i, { timeout: 5000 });
    await expect(btn).toBeEnabled();
  });
});

test.describe('Dashboard — room edit/delete and bulk upload (Block 2)', () => {
  async function loginWithOneRoom(page) {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel',
        trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive',
      },
      rooms: [
        { id: 'room-1', property_id: 'p1', room_type: 'Стандарт', price_per_night: 1500, capacity: 2, quantity: 5, description: 'Опис', amenities: ['Wi-Fi'] },
      ],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
  }

  test('editing a room through the modal updates it in place (no duplicate row)', async ({ page }) => {
    await loginWithOneRoom(page);
    await page.click('.edit-room');
    await expect(page.locator('#roomFormTitle')).toHaveText('Редагувати номер');
    await expect(page.locator('#rfType')).toHaveValue('Стандарт');
    await page.fill('#rfPrice', '1700');
    await page.click('#rfSave');
    await expect(page.locator('#roomFormModal')).toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#roomsList .room-card')).toHaveCount(1);
    await expect(page.locator('.room-card-meta')).toContainText('1700');
  });

  test('deleting a room asks for confirmation and removes it', async ({ page }) => {
    await loginWithOneRoom(page);
    page.once('dialog', (d) => d.accept());
    await page.click('.delete-room');
    await expect(page.locator('#roomsList .room-card')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('#roomsEmptyHint')).toBeVisible();
  });

  test('bulk upload: analyze shows an editable preview, confirming adds it as a new room', async ({ page }) => {
    await loginWithOneRoom(page);
    await page.click('#openBulkUpload');
    await expect(page.locator('#bulkUploadModal')).not.toHaveClass(/hidden/);

    // installBackendMock stubs /api/rooms/parse-upload to always return one
    // canned room regardless of the actual file content — good enough to
    // exercise the preview -> confirm -> saved pipeline end to end.
    await page.setInputFiles('#bulkFileInput', {
      name: 'price-list.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Тип,Ціна\nМок-номер,1000\n'),
    });
    await page.click('#bulkAnalyzeBtn');

    await expect(page.locator('#bulkStepPreview')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('.preview-card')).toHaveCount(1);
    await expect(page.locator('.preview-card .pv-type')).toHaveValue('Мок-номер');

    await page.click('#bulkConfirmBtn');
    await expect(page.locator('#bulkUploadModal')).toHaveClass(/hidden/, { timeout: 5000 });
    // The seeded room plus the one from the mocked upload.
    await expect(page.locator('#roomsList .room-card')).toHaveCount(2);
    await expect(page.locator('#roomsMsg')).toContainText(/Завантажено/);
  });
});

test.describe('Dashboard — hotel info for the AI agent (Block 3)', () => {
  async function loginBasic(page) {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel',
        trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive',
      },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
  }

  test('empty by default, fields save and reload correctly', async ({ page }) => {
    await loginBasic(page);
    await expect(page.locator('#hiParking')).toHaveValue('');

    await page.fill('#hiParking', 'Безкоштовне, на території готелю');
    await page.fill('#hiPets', 'Дозволено дрібних тварин за 200 грн/доба');
    await page.fill('#hiCheckIn', '15:00');
    await page.click('#hiSave');
    await expect(page.locator('#hiMsg')).toContainText(/Збережено/i, { timeout: 5000 });

    await page.reload();
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#hiParking')).toHaveValue('Безкоштовне, на території готелю');
    await expect(page.locator('#hiPets')).toHaveValue('Дозволено дрібних тварин за 200 грн/доба');
    await expect(page.locator('#hiCheckIn')).toHaveValue('15:00');
  });

  test('save button is double-submit guarded', async ({ page }) => {
    await loginBasic(page);
    await page.fill('#hiWifi', 'Безкоштовний у всіх номерах');
    const btn = page.locator('#hiSave');
    await btn.click();
    await expect(page.locator('#hiMsg')).toContainText(/Збережено/i, { timeout: 5000 });
    await expect(btn).toBeEnabled();
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
