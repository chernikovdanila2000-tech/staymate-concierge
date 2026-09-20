/* ============================================================
   StayAI — інформація про готель для гостей (Блок 3)
   Єдине джерело правди про заклад, яке агент вставляє в системний
   промпт. Той самий патерн короткого кешу, що й propertyCache/
   channelCache у server.js/channels.js.
   ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const hotelInfoCache = new Map(); // propertyId -> { data, expiresAt }
const CACHE_TTL_MS = 60 * 1000;

async function getHotelInfo(propertyId) {
  const id = String(propertyId || '').trim();
  if (!id) return null;

  const cached = hotelInfoCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const { data, error } = await supabase
    .from('hotel_info')
    .select('*')
    .eq('property_id', id)
    .maybeSingle();

  if (error) {
    console.error('[getHotelInfo] Supabase error:', error);
    return null;
  }

  hotelInfoCache.set(id, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

function invalidateHotelInfo(propertyId) {
  hotelInfoCache.delete(String(propertyId || '').trim());
}

module.exports = { getHotelInfo, invalidateHotelInfo };
