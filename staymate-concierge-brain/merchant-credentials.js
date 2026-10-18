/* Server-only Monobank acquiring credentials.  The database contains only an
 * AES-GCM envelope; the key lives exclusively in Railway environment config. */
const { encryptCredentials, decryptCredentials } = require('./channel-crypto');

function merchantIdForProperty(propertyId) {
  return `mono:${String(propertyId)}`;
}

async function getMonobankMerchant(supabase, propertyId, { allowSingleTenantFallback = false } = {}) {
  const { data, error } = await supabase
    .from('payment_merchants')
    .select('merchant_id,property_id,provider,credentials,enabled,credential_version,disabled_at')
    .eq('property_id', propertyId).eq('provider', 'monobank_acquiring').maybeSingle();
  if (error) throw error;
  if (data && data.enabled && !data.disabled_at) {
    const credentials = decryptCredentials(data.credentials);
    if (credentials?.token) return { ...data, token: credentials.token, source: 'tenant' };
    return null;
  }
  // Compatibility is deliberately opt-in and is prohibited for a multi-hotel
  // deployment. It permits a controlled single-tenant migration only.
  if (allowSingleTenantFallback && process.env.MONOBANK_ACQUIRING_TOKEN) {
    return { merchant_id: merchantIdForProperty(propertyId), property_id: propertyId,
      provider: 'monobank_acquiring', credential_version: 0,
      token: process.env.MONOBANK_ACQUIRING_TOKEN, source: 'single_tenant_compat' };
  }
  return null;
}

async function saveMonobankMerchant(supabase, { propertyId, token, enabled = true, credentialVersion = 1 }) {
  if (!propertyId || !token) throw new Error('property_id and merchant token are required');
  const row = { merchant_id: merchantIdForProperty(propertyId), property_id: propertyId,
    provider: 'monobank_acquiring', credentials: encryptCredentials({ token }), enabled,
    credential_version: credentialVersion, disabled_at: enabled ? null : new Date().toISOString() };
  const { data, error } = await supabase.from('payment_merchants').upsert(row, { onConflict: 'property_id,provider' }).select('merchant_id,property_id,enabled,credential_version').single();
  if (error) throw error;
  return data;
}

module.exports = { merchantIdForProperty, getMonobankMerchant, saveMonobankMerchant };
