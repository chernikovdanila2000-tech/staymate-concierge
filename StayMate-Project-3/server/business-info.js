/* ============================================================
   StayAI — факти про не-готельний бізнес для системного промпту.
   Той самий патерн кешу, що й hotel-info.js/propertyCache у server.js,
   але для таблиці business_facts (business_type !== 'hospitality').
   ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const businessInfoCache = new Map(); // propertyId -> { data, expiresAt }
const CACHE_TTL_MS = 60 * 1000;

async function getBusinessInfo(propertyId) {
  const id = String(propertyId || '').trim();
  if (!id) return null;

  const cached = businessInfoCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const { data, error } = await supabase
    .from('business_facts')
    .select('*')
    .eq('property_id', id)
    .maybeSingle();

  if (error) {
    console.error('[getBusinessInfo] Supabase error:', error);
    return null;
  }

  businessInfoCache.set(id, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

function invalidateBusinessInfo(propertyId) {
  businessInfoCache.delete(String(propertyId || '').trim());
}

module.exports = { getBusinessInfo, invalidateBusinessInfo };
