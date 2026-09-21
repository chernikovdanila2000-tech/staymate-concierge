const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('Git production source permanently contains the shared launch board', async ({ request }) => {
  const response = await request.get('/internal/launch/');
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain('<title>StayAI — launch-board</title>');
  expect(html).toContain('src="./app.js"');
  expect(html).toContain('Вход владельца');
});

test('Netlify publish directory is pinned in repository configuration', () => {
  const configPath = path.resolve(__dirname, '../../../../netlify.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  expect(config).toContain('publish = "StayMate-Project-3/site"');
});
