const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSystemPrompt } = require('../system-prompt');

test('keeps room catalogue requests separate from missing hotel information', () => {
  const prompt = buildSystemPrompt({ propertyName: 'Test hotel', hotelInfo: null });

  assert.match(prompt, /ціни та наявність НЕ зберігаються/u);
  assert.match(prompt, /ЗАВЖДИ викликай check_availability/u);
  assert.match(prompt, /Ніколи не передавай такий запит адміністрації/u);
  assert.match(prompt, /не є джерелом правди/u);
  assert.match(prompt, /На КОЖНЕ\s+нове запитання/u);
});
