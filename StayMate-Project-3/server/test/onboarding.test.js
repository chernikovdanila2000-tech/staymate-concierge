const test = require('node:test');
const assert = require('node:assert/strict');
const { createOnboardingTools, getSessionProfile, buildOnboardingSystemPrompt, ONBOARDING_TOOL_DEFINITIONS, runOnboardingTurn } = require('../onboarding');

test('a question asked in the same response as a tool call reaches the owner (not just the final filler)', async (t) => {
  const responses = [
    {
      content: [
        { type: 'text', text: 'Скільки у вас постів і майстрів?' },
        { type: 'tool_use', id: 'tu1', name: 'save_business_profile', input: { business_name: 'ADEX STU', business_type: 'СТО' } },
      ],
    },
    { content: [{ type: 'text', text: 'Чекаю на відповідь.' }] },
  ];
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  globalThis.fetch = async () => ({ ok: true, json: async () => responses.shift() });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  const result = await runOnboardingTurn('test-session-question', 'В мене СТО, називається ADEX STU');

  assert.match(result.replyText, /Скільки у вас постів і майстрів\?/u);
  assert.equal(result.profile.business_name, 'ADEX STU');
});

test('save_business_profile merges fields into the session profile without wiping the rest', () => {
  const session = { profile: { business_name: 'Кавʼярня "Дім"' } };
  const tools = createOnboardingTools(session);

  const result = tools.save_business_profile({ hours: 'Щодня 8:00-20:00' });

  assert.deepEqual(session.profile, {
    business_name: 'Кавʼярня "Дім"',
    hours: 'Щодня 8:00-20:00',
  });
  assert.deepEqual(result, { ok: true, saved_fields: ['hours'] });
});

test('save_business_profile tolerates being called with no fields', () => {
  const session = { profile: {} };
  const tools = createOnboardingTools(session);
  const result = tools.save_business_profile(undefined);
  assert.deepEqual(result, { ok: true, saved_fields: [] });
  assert.deepEqual(session.profile, {});
});

test('save_business_profile merges fields (jsonb) separately, without clobbering direct profile props', () => {
  const session = { profile: { business_name: 'Боксерський автомат "Удар"' } };
  const tools = createOnboardingTools(session);

  tools.save_business_profile({ business_type: 'боксерський автомат', fields: { 'Графік роботи': 'Щодня 10:00-22:00' } });
  const result = tools.save_business_profile({ fields: { 'Ціна за раунд': '50 грн' } });

  assert.deepEqual(session.profile, {
    business_name: 'Боксерський автомат "Удар"',
    business_type: 'боксерський автомат',
    fields: { 'Графік роботи': 'Щодня 10:00-22:00', 'Ціна за раунд': '50 грн' },
  });
  assert.deepEqual(result, { ok: true, saved_fields: ['Ціна за раунд'] });
});

test('save_business_profile ignores a non-object fields value instead of crashing', () => {
  const session = { profile: {} };
  const tools = createOnboardingTools(session);
  const result = tools.save_business_profile({ fields: 'not an object' });
  assert.deepEqual(result, { ok: true, saved_fields: [] });
  assert.equal(session.profile.fields, undefined);
});

test('propose_price records the quote on the profile and as the session’s last proposal', () => {
  const session = { profile: {} };
  const tools = createOnboardingTools(session);

  const result = tools.propose_price({ price_uah: 5999, justification: 'Середній потік клієнтів.' });

  assert.deepEqual(result, { ok: true });
  assert.equal(session.profile.proposedPriceUah, 5999);
  assert.equal(session.profile.priceJustification, 'Середній потік клієнтів.');
  assert.deepEqual(session.lastPriceProposal, { priceUah: 5999, justification: 'Середній потік клієнтів.' });
});

test('tool schema requires the fields propose_price and the server depend on', () => {
  const proposePrice = ONBOARDING_TOOL_DEFINITIONS.find((t) => t.name === 'propose_price');
  assert.deepEqual(proposePrice.input_schema.required, ['price_uah', 'justification']);

  const saveProfile = ONBOARDING_TOOL_DEFINITIONS.find((t) => t.name === 'save_business_profile');
  assert.deepEqual(saveProfile.input_schema.required, []);
});

test('getSessionProfile returns null for a session that was never created', () => {
  assert.equal(getSessionProfile('does-not-exist'), null);
});

test('the onboarding prompt never mentions hotel/room concepts and tells the model to use propose_price, not to haggle', () => {
  const prompt = buildOnboardingSystemPrompt();
  assert.doesNotMatch(prompt, /готел|номер|бронюван/u);
  assert.match(prompt, /propose_price/u);
  assert.match(prompt, /save_business_profile/u);
  assert.match(prompt, /Не веди переговори про ціну сам/u);
});

test('the onboarding prompt tells the model fields are not a fixed list, with a worked non-hospitality example', () => {
  const prompt = buildOnboardingSystemPrompt();
  assert.match(prompt, /НЕ фіксований список/u);
  assert.match(prompt, /боксерськ/u);
});
