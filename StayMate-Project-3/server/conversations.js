/* ============================================================
   StayMate — постійне сховище історії розмов (замість in-memory Map)

   Кожна розмова (готель + канал + чат) зберігається як один рядок
   у таблиці `conversations` (Supabase), поле messages — jsonb-масив
   у форматі Claude API. Тримаємо ще й пам'ятний кеш поверх Supabase,
   щоб не ходити в базу на кожне повідомлення одного активного діалогу
   в межах одного "теплого" процесу сервера.
   ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const memoryCache = new Map(); // `${propertyId}:${channel}:${chatId}` -> messages[]

function keyFor(propertyId, channel, chatId) {
  return `${propertyId}:${channel}:${chatId}`;
}

async function getHistory(propertyId, channel, chatId) {
  const key = keyFor(propertyId, channel, chatId);
  if (memoryCache.has(key)) return memoryCache.get(key);

  const { data, error } = await supabase
    .from('conversations')
    .select('messages')
    .eq('property_id', propertyId)
    .eq('channel', channel)
    .eq('chat_id', String(chatId))
    .maybeSingle();

  if (error) {
    console.error('[conversations.getHistory] Supabase error:', error);
    return [];
  }

  const messages = (data && data.messages) || [];
  memoryCache.set(key, messages);
  return messages;
}

async function saveHistory(propertyId, channel, chatId, messages) {
  const key = keyFor(propertyId, channel, chatId);
  memoryCache.set(key, messages);

  const { error } = await supabase
    .from('conversations')
    .upsert(
      {
        property_id: propertyId,
        channel,
        chat_id: String(chatId),
        messages,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'property_id,channel,chat_id' }
    );

  if (error) {
    console.error('[conversations.saveHistory] Supabase error:', error);
  }
}

module.exports = { getHistory, saveHistory };
