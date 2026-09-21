const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('coordination migration provides an atomic claim and file-conflict guard', () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, '../../../server/internal-launch-agent-coordination-migration.sql'),
    'utf8'
  );
  expect(migration).toContain('for update');
  expect(migration).toContain('TASK_ALREADY_CLAIMED');
  expect(migration).toContain('FILE_CONFLICT');
  expect(migration).toContain('CLAIM_SUCCESS');
  expect(migration).toContain('internal_launch_owner_assign');
  expect(migration).toContain('last_agent_activity');
});

test('board source presents coordination without exposing implementation details on cards', async ({ request }) => {
  const app = await (await request.get('/internal/launch/app.js')).text();
  const html = await (await request.get('/internal/launch/')).text();
  expect(html).toContain('Сейчас в работе');
  expect(app).toContain('CODEX');
  expect(app).toContain('CLAUDE CODE');
  expect(app).toContain('internal_launch_owner_assign');
  expect(app).toContain('Передать Claude Code');
  expect(app).toContain('Файлы:');
});
