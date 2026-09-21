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

test.describe('Dashboard — account dropdown subscription countdown (regression)', () => {
  // Reported bug: the account-icon dropdown showed a bare "—" for
  // Підписка forever, because renderAccountStatus() was only ever called
  // once, before currentProperty was fetched — while the main "Тариф і
  // підписка" card (rendered later, once currentProperty was known) showed
  // the real date. Also covers the days -> hours+minutes countdown
  // granularity as the subscription gets close to expiring.

  test('shows a real day countdown, not a stuck "—", once the property loads', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel', subscription_status: 'active', subscription_plan: 'start',
        subscription_active_until: new Date(Date.now() + 28 * 86400000).toISOString(),
      },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('#accountMenuBtn');
    const subRow = page.locator('#accountDropdown .acct-row', { hasText: 'Підписка' }).locator('.acct-value').first();
    await expect(subRow).not.toHaveText('—');
    await expect(subRow).toContainText(/\d+ дн\./);
  });

  test('switches to hours+minutes once less than a day remains', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel', subscription_status: 'active', subscription_plan: 'pro',
        subscription_active_until: new Date(Date.now() + 5 * 3600000 + 20 * 60000).toISOString(),
      },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#subHint')).toContainText(/5 год \d{1,2} хв/);
    await page.click('#accountMenuBtn');
    await expect(page.locator('#accountDropdown .acct-row', { hasText: 'Підписка' }).locator('.acct-value').first()).toContainText(/5 год \d{1,2} хв/);
  });

  test('a missing subscription_plan falls back to a readable label, not a bare dash', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel', subscription_status: 'active', subscription_plan: null,
        subscription_active_until: new Date(Date.now() + 10 * 86400000).toISOString(),
      },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#subHint')).toContainText('Активна підписка: Активна.');
  });

  // Reported: email and the subscription line wrapped/ran together in the
  // narrow (290px) dropdown, especially with a long email address. Fixed by
  // stacking the label above the value (.acct-row--stack) and splitting the
  // subscription line into a bold "plan · countdown" line with the "(until
  // date)" parenthetical on its own smaller line below.
  test('email never wraps and the subscription row shows countdown on top, date below', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'chernikov.danila2000@gmail.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel', subscription_status: 'active', subscription_plan: null,
        subscription_active_until: new Date(Date.now() + 28 * 86400000).toISOString(),
      },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('#accountMenuBtn');

    const emailValue = page.locator('#accountDropdown .acct-row', { hasText: 'Email' }).locator('.acct-value');
    await expect(emailValue).toHaveText('chernikov.danila2000@gmail.com');
    const emailBox = await emailValue.boundingBox();
    const emailScrollWidth = await emailValue.evaluate((el) => el.scrollWidth);
    // Truncated with ellipsis rather than wrapping onto a second line —
    // scrollWidth may exceed the visible box, but the element itself stays
    // single-line height.
    expect(emailBox.height).toBeLessThan(24);
    expect(await emailValue.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap');
    expect(emailScrollWidth).toBeGreaterThan(0);

    const subRow = page.locator('#accountDropdown .acct-row', { hasText: 'Підписка' });
    const mainLine = subRow.locator('.acct-value').first();
    const detailLine = subRow.locator('.acct-value--sub');
    await expect(mainLine).toContainText(/\d+ дн\./);
    await expect(mainLine).not.toContainText('до');
    await expect(detailLine).toContainText(/^\(до .+\)$/);

    const mainBox = await mainLine.boundingBox();
    const detailBox = await detailLine.boundingBox();
    expect(detailBox.y).toBeGreaterThan(mainBox.y);
  });
});

test.describe('Dashboard — themed form fields (regression)', () => {
  test('hotel-info textareas match the dark input theme instead of rendering as plain white boxes', async ({ page }) => {
    await installBackendMock(page, {
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel',
        trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), subscription_status: 'inactive',
      },
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    const bg = await page.locator('#hiParking').evaluate((el) => getComputedStyle(el).backgroundColor);
    // input-bg in dark mode is #1D1E22 = rgb(29, 30, 34) — the point is just
    // that it isn't left at the browser default white/transparent.
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('rgb(255, 255, 255)');
  });
});

test.describe('Dashboard — login/reload loads rooms, hotel info, channels and escalations in the background (regression)', () => {
  // Reported: logging in (or reloading with a stored session) into the
  // cabinet felt slow. Root cause #1: showDashboard() awaited reloadRooms(),
  // loadHotelInfo() and fetchChannels() one after another — three
  // independent Supabase queries paying their network round-trip
  // sequentially — plus afterLogin() made its own separate getUser() call
  // even when the caller already had a fresh user object in hand. Fixed by
  // running the independent queries via Promise.all and reusing the
  // already-known user instead of re-fetching it.
  // Root cause #2 (recurrence): dashScreen only lost its "hidden" class
  // AFTER that whole Promise.all resolved — so the cabinet stayed invisible
  // (and the sign-in button stayed disabled) until the slowest of those
  // queries answered, and each query added to the batch (like
  // fetchEscalations(), added with the Escalations tab) pushed that wait out
  // further. Fixed by revealing the dashboard shell immediately and letting
  // each section populate independently once its own query resolves.
  test('dashboard shell appears immediately, without waiting for any of its data queries', async ({ page }) => {
    await installBackendMock(page, {
      queryDelayMs: 2000,
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel', subscription_status: 'active', subscription_plan: 'pro',
        subscription_active_until: new Date(Date.now() + 28 * 86400000).toISOString(),
      },
    });
    const start = Date.now();
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 800 });
    const elapsed = Date.now() - start;
    // Even with a 2s artificial delay on rooms/hotel_info/channels, the
    // shell must show up almost instantly — it no longer waits on them.
    expect(elapsed).toBeLessThan(800);
  });

  test('rooms list still fills in once its query resolves, after the shell is already visible', async ({ page }) => {
    await installBackendMock(page, {
      queryDelayMs: 500,
      session: { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } },
      property: {
        property_id: 'p1', hotel_name: 'Test Hotel', subscription_status: 'active', subscription_plan: 'pro',
        subscription_active_until: new Date(Date.now() + 28 * 86400000).toISOString(),
      },
      rooms: [{ id: 'r1', property_id: 'p1', room_type: 'Deluxe Suite', price_per_night: 120, capacity: 2, amenities: [] }],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 800 });
    // Right after the shell shows up, the query hasn't resolved yet.
    await expect(page.locator('.room-card')).toHaveCount(0);
    // Once the delayed query resolves, the room shows up on its own.
    await expect(page.locator('.room-card')).toHaveCount(1, { timeout: 2000 });
    await expect(page.locator('.room-card')).toContainText('Deluxe Suite');
  });
});

test.describe('Dashboard — Escalations (new feature)', () => {
  // A guest conversation the AI administrator couldn't handle and passed to
  // a human (escalate_to_human on the backend) — the owner sees it here,
  // with the actual conversation history, and can reply through the same
  // channel the guest wrote on.
  const baseSession = { user: { id: 'u1', email: 'user@example.com', created_at: new Date().toISOString() } };
  const baseProperty = {
    property_id: 'p1', hotel_name: 'Test Hotel', subscription_status: 'active', subscription_plan: 'pro',
    subscription_active_until: new Date(Date.now() + 28 * 86400000).toISOString(),
  };

  test('empty state when there are no escalations', async ({ page }) => {
    await installBackendMock(page, { session: baseSession, property: baseProperty, escalations: [] });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('.dash-tab[data-tab="escalations"]');
    await expect(page.locator('#escEmptyHint')).not.toHaveClass(/hidden/);
    await expect(page.locator('#escTabBadge')).toHaveClass(/hidden/);
  });

  test('shows escalations with a badge counting only the open ones, reason, urgency and channel', async ({ page }) => {
    await installBackendMock(page, {
      session: baseSession,
      property: baseProperty,
      escalations: [
        { id: 'e1', property_id: 'p1', reason: 'Гість просить знижку 50%', urgency: 'high', status: 'open', channel: 'telegram', chat_id: '123', created_at: new Date().toISOString() },
        { id: 'e2', property_id: 'p1', reason: 'Питання про парковку для інваліда', urgency: 'normal', status: 'resolved', channel: 'website', chat_id: 'sess1', created_at: new Date().toISOString() },
      ],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('.dash-tab[data-tab="escalations"]');
    await expect(page.locator('#escTabBadge')).toHaveText('1'); // only e1 is still open
    await expect(page.locator('.esc-row')).toHaveCount(2);
    await expect(page.locator('.esc-row').first()).toContainText('Гість просить знижку');
  });

  test('opening an escalation shows the real conversation history and lets the owner reply', async ({ page }) => {
    await installBackendMock(page, {
      session: baseSession,
      property: baseProperty,
      escalations: [{ id: 'e1', property_id: 'p1', reason: 'Скарга на шум', urgency: 'high', status: 'open', channel: 'telegram', chat_id: '123', created_at: new Date().toISOString() }],
      conversations: [{
        property_id: 'p1', channel: 'telegram', chat_id: '123',
        messages: [
          { role: 'user', content: 'У сусідів дуже голосна музика, не можу заснути' },
          { role: 'assistant', content: 'Мені шкода це чути. Передаю ваше звернення адміністрації.' },
        ],
      }],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('.dash-tab[data-tab="escalations"]');
    await page.click('.esc-row');
    await expect(page.locator('#escalationModal')).not.toHaveClass(/hidden/);
    await expect(page.locator('#escChatHistory')).toContainText('голосна музика');
    await expect(page.locator('#escReplyBlock')).not.toHaveClass(/hidden/);

    await page.fill('#escReplyText', "Ми зв'яжемось із сусідами найближчим часом.");
    await page.click('#escReplySend');
    await expect(page.locator('#escReplyMsg')).toContainText(/надіслано/i);
    const calls = await page.evaluate(() => window.__qaEscalationReplyCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ propertyId: 'p1', escalationId: 'e1', message: "Ми зв'яжемось із сусідами найближчим часом." });
    // Reply gets appended to the conversation and re-rendered right away —
    // the owner sees it land in the same thread, not just a "sent" toast.
    await expect(page.locator('#escChatHistory')).toContainText("Ми зв'яжемось");
  });

  test('a test-chat escalation has no reply box — that channel has no way to push a delayed message', async ({ page }) => {
    await installBackendMock(page, {
      session: baseSession,
      property: baseProperty,
      escalations: [{ id: 'e2', property_id: 'p1', reason: 'Питання про сніданок', urgency: 'low', status: 'open', channel: 'test', chat_id: 'sess1', created_at: new Date().toISOString() }],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('.dash-tab[data-tab="escalations"]');
    await page.click('.esc-row');
    await expect(page.locator('#escReplyBlock')).toHaveClass(/hidden/);
    await expect(page.locator('#escNoChannelHint')).not.toHaveClass(/hidden/);
  });

  test('a website-widget escalation now has a reply box — the widget polls for the owner reply', async ({ page }) => {
    await installBackendMock(page, {
      session: baseSession,
      property: baseProperty,
      escalations: [{ id: 'e2', property_id: 'p1', reason: 'Питання про сніданок', urgency: 'low', status: 'open', channel: 'website', chat_id: 'sess1', created_at: new Date().toISOString() }],
      conversations: [{
        property_id: 'p1', channel: 'website', chat_id: 'sess1',
        messages: [
          { role: 'user', content: 'До котрої години сніданок?' },
          { role: 'assistant', content: 'Передаю ваше питання адміністратору.' },
        ],
      }],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('.dash-tab[data-tab="escalations"]');
    await page.click('.esc-row');
    await expect(page.locator('#escReplyBlock')).not.toHaveClass(/hidden/);
    await expect(page.locator('#escNoChannelHint')).toHaveClass(/hidden/);

    await page.fill('#escReplyText', 'Сніданок з 8:00 до 11:00.');
    await page.click('#escReplySend');
    await expect(page.locator('#escReplyMsg')).toContainText(/надіслано/i);
    const calls = await page.evaluate(() => window.__qaEscalationReplyCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ propertyId: 'p1', escalationId: 'e2', message: 'Сніданок з 8:00 до 11:00.' });
    await expect(page.locator('#escChatHistory')).toContainText('Сніданок з 8:00 до 11:00');
  });

  test('marking an escalation resolved updates the badge count and can be reopened', async ({ page }) => {
    await installBackendMock(page, {
      session: baseSession,
      property: baseProperty,
      escalations: [{ id: 'e1', property_id: 'p1', reason: 'Втрачені ключі', urgency: 'normal', status: 'open', channel: 'viber', chat_id: '456', created_at: new Date().toISOString() }],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('.dash-tab[data-tab="escalations"]');
    await expect(page.locator('#escTabBadge')).toHaveText('1');
    await page.click('.esc-row');
    await page.click('#escToggleStatus');
    await expect(page.locator('#escToggleStatus')).toContainText(/знову/i);
    await expect(page.locator('#escTabBadge')).toHaveClass(/hidden/);
    await page.click('#escModalClose');
    await expect(page.locator('.esc-row')).toHaveClass(/is-resolved/);

    // And back open again.
    await page.click('.esc-row');
    await page.click('#escToggleStatus');
    await expect(page.locator('#escTabBadge')).toHaveText('1');
  });

  test('a reply failure shows an error and keeps the draft in the textbox', async ({ page }) => {
    await installBackendMock(page, {
      session: baseSession,
      property: baseProperty,
      failEscalationReply: true,
      escalations: [{ id: 'e1', property_id: 'p1', reason: 'Тест', urgency: 'normal', status: 'open', channel: 'telegram', chat_id: '1', created_at: new Date().toISOString() }],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('.dash-tab[data-tab="escalations"]');
    await page.click('.esc-row');
    await page.fill('#escReplyText', 'Відповідь гостю');
    await page.click('#escReplySend');
    await expect(page.locator('#escReplyMsg')).toContainText(/mock failure/i);
    await expect(page.locator('#escReplyText')).toHaveValue('Відповідь гостю');
  });

  test('deleting an escalation removes it and its conversation, and asks for confirmation first', async ({ page }) => {
    await installBackendMock(page, {
      session: baseSession,
      property: baseProperty,
      escalations: [
        { id: 'e1', property_id: 'p1', reason: 'Скарга на шум', urgency: 'high', status: 'open', channel: 'telegram', chat_id: '123', created_at: new Date().toISOString() },
        { id: 'e2', property_id: 'p1', reason: 'Питання про сніданок', urgency: 'low', status: 'open', channel: 'viber', chat_id: '456', created_at: new Date().toISOString() },
      ],
      conversations: [{
        property_id: 'p1', channel: 'telegram', chat_id: '123',
        messages: [{ role: 'user', content: 'У сусідів дуже голосна музика' }],
      }],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('.dash-tab[data-tab="escalations"]');
    await expect(page.locator('.esc-row')).toHaveCount(2);

    await page.locator('.esc-row', { hasText: 'Скарга на шум' }).click();
    await expect(page.locator('#escalationModal')).not.toHaveClass(/hidden/);

    // Dismissing the confirm dialog must not delete anything.
    page.once('dialog', (d) => d.dismiss());
    await page.click('#escDeleteBtn');
    await expect(page.locator('.esc-row')).toHaveCount(2);

    // Accepting it deletes the escalation, closes the modal, and drops the
    // linked conversation row too (so no history is left orphaned behind).
    page.once('dialog', (d) => d.accept());
    await page.click('#escDeleteBtn');
    await expect(page.locator('#escalationModal')).toHaveClass(/hidden/);
    await expect(page.locator('.esc-row')).toHaveCount(1);
    await expect(page.locator('.esc-row')).toContainText('Питання про сніданок');
    const conv = await page.evaluate(() => JSON.parse(localStorage.getItem('__qaState')).conversations);
    expect(conv.find((c) => c.channel === 'telegram' && c.chat_id === '123')).toBeUndefined();
  });

  // Reported: deleting an escalation appeared to work (row vanished from the
  // list) but came back after reloading the page — it was never actually
  // deleted. Root cause: a bare .delete() never errors when Postgres RLS
  // silently blocks it (0 rows affected is not an error), which is exactly
  // what happens if the DELETE policy migration hasn't been run in Supabase
  // yet — the cabinet had no way to tell "deleted" apart from "blocked" and
  // always assumed success. Fixed by chaining .select() to see which rows
  // actually got deleted and surfacing an error when that comes back empty.
  test('a delete silently blocked by RLS shows an error and keeps the escalation in the list', async ({ page }) => {
    await installBackendMock(page, {
      session: baseSession,
      property: baseProperty,
      failEscalationDelete: true,
      escalations: [{ id: 'e1', property_id: 'p1', reason: 'Скарга на шум', urgency: 'high', status: 'open', channel: 'telegram', chat_id: '123', created_at: new Date().toISOString() }],
    });
    await page.goto('/cabinet/');
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('.dash-tab[data-tab="escalations"]');
    await page.click('.esc-row');
    page.once('dialog', (d) => d.accept());
    await page.click('#escDeleteBtn');
    await expect(page.locator('#escReplyMsg')).toContainText(/не вдалося/i);
    // Modal stays open and the row is still there — no false "success".
    await expect(page.locator('#escalationModal')).not.toHaveClass(/hidden/);
    await expect(page.locator('.esc-row')).toHaveCount(1);
    // And it survives a reload too — nothing was removed client-side either.
    await page.reload();
    await expect(page.locator('#dashScreen')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.click('.dash-tab[data-tab="escalations"]');
    await expect(page.locator('.esc-row')).toHaveCount(1);
  });
});
