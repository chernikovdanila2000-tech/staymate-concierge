const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('Git production source permanently contains the shared launch board', async ({ request }) => {
  const response = await request.get('/internal/launch/');
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain('<title>StayAI — план запуска</title>');
  expect(html).toContain('src="./app.js"');
  expect(html).toContain('Вход владельца');
});

test('owner-friendly board keeps plain-language detail UX in the permanent source', async ({ request }) => {
  const html = await (await request.get('/internal/launch/')).text();
  const app = await (await request.get('/internal/launch/app.js')).text();

  expect(html).toContain('Что делать сейчас');
  expect(html).toContain('Что всё это значит?');
  expect(html).toContain('@media(max-width:560px)');
  expect(app).toContain('ЧТО ЭТО ВООБЩЕ ТАКОЕ?');
  expect(app).toContain('ПОШАГОВЫЙ ПЛАН');
  expect(app).toContain('ЧТО НУЖНО ОТ НАС');
  expect(app).toContain('Технические детали');
  expect(app).toContain('Tenant Isolation');
  expect(app).toContain('WhatsApp Business API');
  expect(app).toContain('stepsFromForm');
  expect(app).toContain('eq(\'version\',t.version)');
});

test('Netlify publish directory is pinned in repository configuration', () => {
  const configPath = path.resolve(__dirname, '../../../../netlify.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  expect(config).toContain('publish = "StayMate-Project-3/site"');
});
