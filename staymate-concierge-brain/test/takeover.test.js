const test = require('node:test');
const assert = require('node:assert/strict');
const { isConversationTakenOver } = require('../takeover');

function fakeSupabase(rows, error = null) {
  const filters = [];
  const query = {
    select() { return this; },
    eq(column, value) { filters.push(['eq', column, value]); return this; },
    neq(column, value) { filters.push(['neq', column, value]); return this; },
    async limit() { return { data: rows, error }; },
  };
  return { from(table) { assert.equal(table, 'escalations'); return query; }, filters };
}

test('an open escalation pauses the AI for that exact property and conversation', async () => {
  const supabase = fakeSupabase([{ id: 'open-escalation' }]);
  const takenOver = await isConversationTakenOver({
    supabase,
    propertyId: 'hotel-a',
    channel: 'whatsapp',
    chatId: 123,
  });

  assert.equal(takenOver, true);
  assert.deepEqual(supabase.filters, [
    ['eq', 'property_id', 'hotel-a'],
    ['eq', 'channel', 'whatsapp'],
    ['eq', 'chat_id', '123'],
    ['neq', 'status', 'resolved'],
  ]);
});

test('a resolved escalation returns the conversation to AI', async () => {
  const supabase = fakeSupabase([]);
  assert.equal(await isConversationTakenOver({
    supabase,
    propertyId: 'hotel-a',
    channel: 'telegram',
    chatId: 'guest-1',
  }), false);
});

test('a malformed conversation cannot accidentally be treated as taken over', async () => {
  assert.equal(await isConversationTakenOver({
    supabase: fakeSupabase([{ id: 'should-not-query' }]),
    propertyId: 'hotel-a',
    channel: 'website',
    chatId: null,
  }), false);
});
