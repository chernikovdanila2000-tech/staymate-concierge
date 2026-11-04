const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAlternation } = require('../message-alternation');

test('leaves an already-alternating conversation untouched', () => {
  const history = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello' },
    { role: 'user', content: 'Thanks' },
  ];
  assert.deepEqual(normalizeAlternation(history), history);
});

test('merges consecutive guest messages saved before appendGuestMessage existed', () => {
  const history = [
    { role: 'assistant', content: 'Передав питання адміністрації' },
    { role: 'user', content: 'Так є' },
    { role: 'user', content: 'знизу готелю' },
    { role: 'user', content: 'Добре' },
  ];
  assert.deepEqual(normalizeAlternation(history), [
    { role: 'assistant', content: 'Передав питання адміністрації' },
    { role: 'user', content: 'Так є\nзнизу готелю\nДобре' },
  ]);
});

test('merges consecutive owner replies the same way', () => {
  const history = [
    { role: 'user', content: 'Питання' },
    { role: 'assistant', content: 'Відповідь 1', from_owner: true },
    { role: 'assistant', content: 'Відповідь 2', from_owner: true },
  ];
  assert.deepEqual(normalizeAlternation(history), [
    { role: 'user', content: 'Питання' },
    { role: 'assistant', content: 'Відповідь 1\nВідповідь 2', from_owner: true },
  ]);
});

test('never merges across array content (tool calls/results), only plain strings', () => {
  const toolResult = [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }];
  const history = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'f', input: {} }] },
    { role: 'user', content: toolResult },
  ];
  assert.deepEqual(normalizeAlternation(history), history);
});

test('does not mutate the original messages', () => {
  const history = [
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
  ];
  normalizeAlternation(history);
  assert.deepEqual(history, [
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
  ]);
});
