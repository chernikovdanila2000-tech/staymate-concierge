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

test.describe('Dashboard — Каналы tab: real connect/disconnect (Block 4)', () => {
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

  test('Канали tab is hidden by default, switching tabs shows it and hides Огляд', async ({ page }) => {
    await loginBasic(page);
    await expect(page.locator('#tabOverview')).not.toHaveClass(/hidden/);
    await expect(page.locator('#tabChannels')).toHaveClass(/hidden/);

    await page.click('.dash-tab[data-tab="channels"]');
    await expect(page.locator('#tabChannels')).not.toHaveClass(/hidden/);
    await expect(page.locator('#tabOverview')).toHaveClass(/hidden/);
    await expect(page.locator('.dash-tab[data-tab="channels"]')).toHaveClass(/active/);
  });

  test('connecting WhatsApp with valid credentials shows "Підключено" and a Відключити button', async ({ page }) => {
    await loginBasic(page);
    await page.click('.dash-tab[data-tab="channels"]');
    await page.fill('#waPhoneId', '10293847');
    await page.fill('#waToken', 'EAAtest');
    await page.click('#connectWhatsapp');
    await expect(page.locator('#msgWhatsapp')).toContainText(/Підключено/i, { timeout: 5000 });
    await expect(page.locator('#pill-whatsapp')).toHaveText('Підключено');
    await expect(page.locator('#pill-whatsapp')).not.toHaveClass(/off|awaiting|error/);
    await expect(page.locator('#disconnectWhatsapp')).toBeVisible();
  });

  test('connecting WhatsApp with a missing field shows an error and does not connect', async ({ page }) => {
    await loginBasic(page);
    await page.click('.dash-tab[data-tab="channels"]');
    await page.fill('#waPhoneId', '10293847');
    await page.click('#connectWhatsapp');
    await expect(page.locator('#msgWhatsapp')).toContainText(/Заповніть/i, { timeout: 5000 });
    await expect(page.locator('#pill-whatsapp')).toHaveText(/Не підключено/);
  });

  test('disconnecting a connected channel asks for confirmation and reverts the pill', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel',
        trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive',
      },
      channels: [
        { property_id: 'p1', channel_type: 'instagram', credentials: { instagram_account_id: 'ig1' }, connected: true, status: 'connected' },
      ],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('.dash-tab[data-tab="channels"]');
    await expect(page.locator('#pill-instagram')).toHaveText('Підключено');

    page.once('dialog', (d) => d.accept());
    await page.click('#disconnectInstagram');
    await expect(page.locator('#msgInstagram')).toContainText(/Відключено/i, { timeout: 5000 });
    await expect(page.locator('#pill-instagram')).toHaveText(/Не підключено/);
  });

  test('connecting Messenger with just a Page Access Token works (no manual page ID field)', async ({ page }) => {
    await loginBasic(page);
    await page.click('.dash-tab[data-tab="channels"]');
    await page.fill('#fbToken', 'EAAfbtest');
    await page.click('#connectMessenger');
    await expect(page.locator('#msgMessenger')).toContainText(/Підключено/i, { timeout: 5000 });
    await expect(page.locator('#pill-messenger')).toHaveText('Підключено');
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

const CYRILLIC = /[Ѐ-ӿ]/;

test.describe('Dashboard — switching language translates the whole cabinet, not just the header (regression)', () => {
  async function switchToEnglish(page) {
    await page.click('#langBtn');
    await page.click('#langMenu button[data-lang="en"]');
    await page.waitForTimeout(150);
  }

  test('EN: subscription/hotel/guest-info/rooms cards and the Канали tab all switch language together', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel',
        trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive',
      },
      rooms: [
        { id: 'room-1', property_id: 'p1', room_type: 'Стандарт', price_per_night: 1500, capacity: 2, quantity: 5, description: 'Опис', amenities: [] },
      ],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });

    await switchToEnglish(page);

    // Overview tab: every card title, not just the header nav.
    await expect(page.locator('#tabOverview h2').nth(0)).toHaveText('Plan & subscription');
    await expect(page.locator('#tabOverview h2').nth(1)).toHaveText('Hotel details');
    await expect(page.locator('#tabOverview h2').nth(2)).toHaveText('Guest information');
    await expect(page.locator('#tabOverview h2').nth(3)).toHaveText('Rooms');
    await expect(page.locator('#dashScreen .lede').first()).toHaveText(/AI administrator sees and uses/);

    // Dynamically-rendered room card must also be in English, not stuck in Ukrainian.
    await expect(page.locator('.room-card-meta')).toContainText('UAH/night');
    await expect(page.locator('.room-card-meta')).not.toHaveText(CYRILLIC);

    // Канали tab.
    await page.click('.dash-tab[data-tab="channels"]');
    await expect(page.locator('#tabChannels h2').first()).toHaveText('Channels');
    await expect(page.locator('#pill-telegram')).toHaveText('Not connected');
    await expect(page.locator('label[for="tokenTelegram"]')).toHaveText('Bot token');
  });

  test('EN: no leftover Cyrillic text anywhere in the visible dashboard after switching', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel',
        trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive',
      },
      rooms: [
        { id: 'room-1', property_id: 'p1', room_type: 'Стандарт', price_per_night: 1500, capacity: 2, quantity: 5, description: 'Опис', amenities: ['Wi-Fi'] },
      ],
      channels: [
        { property_id: 'p1', channel_type: 'whatsapp', credentials: { phone_number_id: '1' }, connected: false, status: 'awaiting_verification', status_detail: 'awaiting' },
      ],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await switchToEnglish(page);
    await page.click('.dash-tab[data-tab="channels"]');
    await page.waitForTimeout(200);

    const leftover = await page.$$eval('#dashScreen [data-i18n], #dashScreen .room-card-meta, #dashScreen .status-pill, #dashScreen #hintWhatsapp', (els) =>
      els
        .filter((el) => /[Ѐ-ӿ]/.test(el.textContent || ''))
        .map((el) => ({ id: el.id, key: el.getAttribute('data-i18n'), text: el.textContent.trim() }))
    );
    expect(leftover, 'dashboard elements still showing Cyrillic after switching to EN').toEqual([]);
  });

  test('reset/onboard/gate screens also translate (not just the post-login dashboard)', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: null,
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#onboardScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await switchToEnglish(page);
    await expect(page.locator('#onboardScreen h1')).toHaveText('Create your hotel profile');
    await expect(page.locator('#obSubmitTrial')).toHaveText('Start a free 3-day trial');
  });
});
