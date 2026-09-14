/* ============================================================
   StayAI — довідник підключених каналів (channels)
   Кожен готель може мати кілька каналів зв'язку (telegram, viber,
   whatsapp, instagram). Дані живуть у таблиці `channels` (Supabase),
   тут — тільки читання з коротким кешем, за тим самим патерном,
   що й propertyCache у server.js.
   ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const channelCache = new Map(); // `${propertyId}:${channelType}` -> { data, expiresAt }
const CACHE_TTL_MS = 60 * 1000;

async function getChannel(propertyId, channelType) {
  const key = `${propertyId}:${channelType}`;
  const cached = channelCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const { data, error } = await supabase
    .from('channels')
    .select('property_id, channel_type, credentials, connected')
    .eq('property_id', propertyId)
    .eq('channel_type', channelType)
    .maybeSingle();

  if (error) {
    console.error('[getChannel] Supabase error:', error);
    return null;
  }

  channelCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

function invalidateChannel(propertyId, channelType) {
  channelCache.delete(`${propertyId}:${channelType}`);
}

/**
 * Токен Telegram-бота: спершу дивимось у channels (нова схема), якщо там
 * немає — падаємо назад на старе поле properties.telegram_bot_token
 * (готелі, підключені до появи таблиці channels).
 */
async function getTelegramToken(propertyId, property) {
  const channel = await getChannel(propertyId, 'telegram');
  if (channel && channel.connected && channel.credentials && channel.credentials.bot_token) {
    return channel.credentials.bot_token;
  }
  return (property && property.telegram_bot_token) || null;
}

async function getViberToken(propertyId) {
  const channel = await getChannel(propertyId, 'viber');
  if (channel && channel.connected && channel.credentials && channel.credentials.bot_token) {
    return channel.credentials.bot_token;
  }
  return null;
}

module.exports = { getChannel, invalidateChannel, getTelegramToken, getViberToken };
