const { test, expect } = require('@playwright/test');

const mockSupabase = `
  window.sb = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'owner-a' } } } }),
      onAuthStateChange: () => ({ data: { subscription: {} } }),
      signInWithOtp: async () => ({ error: null }),
      signOut: async () => ({ error: null })
    },
    rpc: async () => ({ data: true, error: null }),
    from: () => ({
      select: () => ({ order: async () => ({ data: [{
        id: 'whatsapp', section: 'КАНАЛЫ', title: 'WhatsApp', short_title: 'Ответы гостям в WhatsApp',
        status: 'done', priority: 'P0', remaining: 'Ничего.', remaining_plain: 'Ничего — канал готов.',
        sort_order: 1, note: '', responsible: '', owner_action: false, version: 1,
        updated_at: '2026-01-01T00:00:00.000Z', steps: []
      }] }) }),
      update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: {}, error: null }) }) }) }) }),
      insert: async () => ({ error: null }),
      delete: () => ({ eq: () => ({ eq: () => ({ select: async () => ({ data: [{}], error: null }) }) }) })
    }),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: async () => {}
  };
`;

test('owner sees a short card and a plain-language plan after opening it', async ({ page }) => {
  await page.route('**/supabase-config.js', route => route.fulfill({ contentType: 'application/javascript', body: mockSupabase }));
  await page.goto('/internal/launch/');

  await expect(page.getByRole('heading', { name: 'План запуска' })).toBeVisible();
  await expect(page.getByText('Ответы гостям в WhatsApp')).toBeVisible();
  await page.locator('.task').click();

  await expect(page.getByText('ЧТО ЭТО ВООБЩЕ ТАКОЕ?')).toBeVisible();
  await expect(page.getByText('ЗАЧЕМ ЭТО НУЖНО?')).toBeVisible();
  await expect(page.getByText('ПОШАГОВЫЙ ПЛАН')).toBeVisible();
  await expect(page.getByText('ЧТО НУЖНО ОТ НАС')).toBeVisible();
  await expect(page.getByText('Технические детали')).toBeVisible();
});

test('owner task form is one column on a phone and does not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('**/supabase-config.js', route => route.fulfill({ contentType: 'application/javascript', body: mockSupabase }));
  await page.goto('/internal/launch/');
  await page.getByRole('button', { name: 'Добавить задачу' }).click();

  await expect(page.getByText('Короткое понятное название')).toBeVisible();
  await expect(page.getByText('Пошаговый план')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
