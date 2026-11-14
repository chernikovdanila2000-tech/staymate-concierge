const test = require('node:test');
const assert = require('node:assert/strict');
const { isConversationTakenOver, resolveConversationEscalations } = require('../takeover');

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

function fakeUpdatingSupabase(updatedRows, error = null) {
  const calls = { filters: [], patch: null };
  const query = {
    update(patch) { calls.patch = patch; return this; },
    eq(column, value) { calls.filters.push(['eq', column, value]); return this; },
    neq(column, value) { calls.filters.push(['neq', column, value]); return this; },
    async select() { return { data: updatedRows, error }; },
  };
  return { from(table) { assert.equal(table, 'escalations'); return query; }, calls };
}

test('resolving hands the conversation back to AI by closing EVERY open escalation in it, not just one', async () => {
  // Two open rows for one chat (e.g. created before duplicate-prevention):
  // closing only the clicked one would leave the AI paused by the other.
  const supabase = fakeUpdatingSupabase([{ id: 'esc-1' }, { id: 'esc-2' }]);
  const now = new Date('2026-11-14T10:00:00.000Z');

  const resolved = await resolveConversationEscalations({
    supabase,
    propertyId: 'hotel-a',
    channel: 'instagram',
    chatId: 987,
    now,
  });

  assert.deepEqual(resolved, ['esc-1', 'esc-2']);
  assert.deepEqual(supabase.calls.patch, { status: 'resolved', resolved_at: '2026-11-14T10:00:00.000Z' });
  // Scoped by exactly the same keys isConversationTakenOver checks.
  assert.deepEqual(supabase.calls.filters, [
    ['eq', 'property_id', 'hotel-a'],
    ['eq', 'channel', 'instagram'],
    ['eq', 'chat_id', '987'],
    ['neq', 'status', 'resolved'],
  ]);
});

test('resolving surfaces a database failure instead of pretending the AI is back', async () => {
  const supabase = fakeUpdatingSupabase(null, { message: 'permission denied' });
  await assert.rejects(
    resolveConversationEscalations({ supabase, propertyId: 'hotel-a', channel: 'website', chatId: 's1' }),
    /permission denied/
  );
});

test('resolving a conversation without channel/chat is a no-op, never a property-wide update', async () => {
  const supabase = fakeUpdatingSupabase([{ id: 'should-not-touch' }]);
  assert.deepEqual(await resolveConversationEscalations({
    supabase,
    propertyId: 'hotel-a',
    channel: null,
    chatId: 's1',
  }), []);
  assert.equal(supabase.calls.patch, null);
});

test('a malformed conversation cannot accidentally be treated as taken over', async () => {
  assert.equal(await isConversationTakenOver({
    supabase: fakeSupabase([{ id: 'should-not-query' }]),
    propertyId: 'hotel-a',
    channel: 'website',
    chatId: null,
  }), false);
});
