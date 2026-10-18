/* Server-only Monobank acquiring credentials.  The database contains only an
 * AES-GCM envelope; the key lives exclusively in Railway environment config. */
const { encryptCredentials, decryptCredentials } = require('./channel-crypto');

function merchantIdForProperty(propertyId) {
  return `mono:${String(propertyId)}`;
}

async function getMonobankMerchant(supabase, propertyId) {
  const { data, error } = await supabase
    .from('payment_merchants')
    .select('merchant_id,property_id,provider,credentials,enabled,credential_version,disabled_at')
    .eq('property_id', propertyId).eq('provider', 'monobank_acquiring').maybeSingle();
  if (error) throw error;
  if (data && data.enabled && !data.disabled_at) {
    // The query is tenant-filtered, but fail closed if a malformed database
    // result ever escapes that filter.  Credentials must never be selected by
    // a caller-supplied or unrelated merchant identifier.
    if (data.property_id !== propertyId || data.merchant_id !== merchantIdForProperty(propertyId)) return null;
    const credentials = decryptCredentials(data.credentials);
    if (credentials?.token) return { ...data, token: credentials.token, source: 'tenant' };
    return null;
  }
  // Never fall back to a process-wide acquiring token.  A runtime flag cannot
  // prove that only one property exists, and using it would let another hotel
  // receive invoices through the wrong merchant.  Each property must have an
  // enabled, encrypted row above.
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
