'use strict';

function projectRefFromSupabaseUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    const suffix = '.supabase.co';
    return host.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
  } catch { return ''; }
}

function assertStagingIsolation(env = process.env) {
  if (env.REQUIRE_STAGING_DB_ISOLATION !== 'true') return { enforced: false };
  const stagingRef = projectRefFromSupabaseUrl(env.SUPABASE_URL);
  const productionRef = projectRefFromSupabaseUrl(env.PRODUCTION_SUPABASE_URL);
  if (!stagingRef || !productionRef) throw new Error('staging_db_isolation_unconfirmed');
  if (stagingRef === productionRef) throw new Error('staging_db_isolation_failed');
  return { enforced: true, stagingRef, productionRef };
}

module.exports = { projectRefFromSupabaseUrl, assertStagingIsolation };
