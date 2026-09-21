const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSystemPrompt, getDateContext } = require('../system-prompt');

test('keeps room catalogue requests separate from missing hotel information', () => {
  const prompt = buildSystemPrompt({ propertyName: 'Test hotel', hotelInfo: null });

  assert.match(prompt, /ціни та наявність НЕ зберігаються/u);
  assert.match(prompt, /ЗАВЖДИ викликай check_availability/u);
  assert.match(prompt, /Ніколи не передавай такий запит адміністрації/u);
  assert.match(prompt, /не є джерелом правди/u);
  assert.match(prompt, /На КОЖНЕ\s+нове запитання/u);
});

test('anchors today, tomorrow and the day after tomorrow in the hotel time zone', () => {
  const dates = getDateContext({
    now: new Date('2026-09-21T21:30:00.000Z'),
    timeZone: 'Europe/Kyiv',
  });
  assert.deepEqual(dates, {
    timeZone: 'Europe/Kyiv',
    today: '2026-09-22',
    tomorrow: '2026-09-23',
    dayAfterTomorrow: '2026-09-24',
  });

  const prompt = buildSystemPrompt({
    propertyName: 'Test hotel',
    now: new Date('2026-09-21T21:30:00.000Z'),
    timeZone: 'Europe/Kyiv',
  });
  assert.match(prompt, /«завтра» \/ «tomorrow» = 2026-09-23/u);
  assert.match(prompt, /Не проси гостя повторно назвати «точні дати»/u);
});
