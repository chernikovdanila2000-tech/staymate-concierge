const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSystemPrompt, buildGenericSystemPrompt, formatBusinessInfo, getDateContext } = require('../system-prompt');

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

test('defaults to the hospitality prompt when businessType is omitted (no regression for existing hotels)', () => {
  const withDefault = buildSystemPrompt({ propertyName: 'Test hotel' });
  const withExplicitHospitality = buildSystemPrompt({ propertyName: 'Test hotel', businessType: 'hospitality' });
  assert.equal(withDefault, withExplicitHospitality);
  assert.match(withDefault, /ЗАВЖДИ викликай check_availability/u);
});

test('a non-hospitality business gets the generic prompt instead, with no room/booking language', () => {
  const prompt = buildSystemPrompt({
    businessType: 'services',
    propertyName: 'Салон краси «Лілея»',
    businessInfo: { fields: { 'Чим займається бізнес': 'Перукарня та манікюр', 'Графік роботи': 'Пн-Сб 9:00-19:00' } },
  });

  assert.match(prompt, /Салон краси «Лілея»/u);
  assert.match(prompt, /Чим займається бізнес: Перукарня та манікюр/u);
  assert.match(prompt, /Графік роботи: Пн-Сб 9:00-19:00/u);
  assert.doesNotMatch(prompt, /check_availability/u);
  assert.doesNotMatch(prompt, /create_booking/u);
  assert.doesNotMatch(prompt, /заїзд|виїзд|бронюван/u);
});

test('a business with arbitrary, non-hospitality-shaped fields (not a fixed vocabulary) renders them as-is', () => {
  const prompt = buildGenericSystemPrompt({
    propertyName: 'Боксерський автомат «Удар»',
    businessInfo: { fields: { 'Обладнання': '2 боксерські груші', 'Ціна за раунд': '50 грн' } },
  });
  assert.match(prompt, /Обладнання: 2 боксерські груші/u);
  assert.match(prompt, /Ціна за раунд: 50 грн/u);
});

test('generic prompt escalates missing business info instead of inventing it, same rule as hotels', () => {
  const prompt = buildGenericSystemPrompt({ propertyName: 'Кавʼярня', businessInfo: null });
  assert.match(prompt, /\(Власник ще не заповнив цю інформацію\.\)/u);
  assert.match(prompt, /одразу виклич escalate_to_human/u);
});

test('formatBusinessInfo lists only filled-in fields, in the order they were set', () => {
  const formatted = formatBusinessInfo({ fields: { 'Графік роботи': 'Щодня 10:00-22:00', 'Ціна': '', 'Чим займається бізнес': 'Кавʼярня' } });
  assert.equal(formatted, '- Графік роботи: Щодня 10:00-22:00\n- Чим займається бізнес: Кавʼярня');
});

test('formatBusinessInfo treats a missing or malformed fields object the same as no info at all', () => {
  assert.equal(formatBusinessInfo({}), '(Власник ще не заповнив цю інформацію.)');
  assert.equal(formatBusinessInfo({ fields: 'not an object' }), '(Власник ще не заповнив цю інформацію.)');
});
