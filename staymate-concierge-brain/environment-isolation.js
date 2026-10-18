'use strict';

const DATABASE_CONNECTION_KEYS = [
  'DATABASE_URL',
  'SUPABASE_DB_URL',
  'SUPABASE_DATABASE_URL',
  'DIRECT_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NON_POOLING',
];

function projectRefFromSupabaseUrl(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    const suffix = '.supabase.co';
    return host.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
  } catch { return ''; }
}

function projectRefFromDatabaseUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    const direct = host.match(/^db\.([a-z0-9-]+)\.supabase\.co$/);
    if (direct) return direct[1];

    // Supabase pooler hosts do not include the project ref, but its required
    // username and/or the `options=project=<ref>` connection parameter do.
    const username = decodeURIComponent(url.username || '');
    const userMatch = username.match(/(?:^|\.)([a-z0-9-]{6,})$/i);
    if (host.endsWith('.pooler.supabase.com') && userMatch) return userMatch[1].toLowerCase();
    const options = decodeURIComponent(url.searchParams.get('options') || '');
    const optionMatch = options.match(/(?:^|\s)project=([a-z0-9-]+)/i);
    return optionMatch ? optionMatch[1].toLowerCase() : projectRefFromSupabaseUrl(value);
  } catch { return ''; }
}

function expectedProjectRef(env, key) {
  const value = String(env[key] || '').trim().toLowerCase();
  return /^[a-z0-9-]{6,}$/.test(value) ? value : '';
}

function isStagingEnvironment(env) {
  const declared = String(env.STAYAI_ENVIRONMENT || env.DEPLOYMENT_ENVIRONMENT || '').toLowerCase();
  const railway = String(env.RAILWAY_ENVIRONMENT_NAME || '').toLowerCase();
  return declared === 'staging' || railway === 'staging' || railway === 'voice-realtime-test';
}

function assertStagingIsolation(env = process.env) {
  if (env.REQUIRE_STAGING_DB_ISOLATION !== 'true' && !isStagingEnvironment(env)) return { enforced: false };
  const stagingRef = projectRefFromSupabaseUrl(env.SUPABASE_URL);
  const productionRef = projectRefFromSupabaseUrl(env.PRODUCTION_SUPABASE_URL);
  const expectedStagingRef = expectedProjectRef(env, 'STAGING_SUPABASE_PROJECT_REF');
  const expectedProductionRef = expectedProjectRef(env, 'PRODUCTION_SUPABASE_PROJECT_REF');
  if (!stagingRef || !productionRef || !expectedStagingRef || !expectedProductionRef) {
    throw new Error('staging_db_isolation_unconfirmed');
  }
  if (stagingRef !== expectedStagingRef || productionRef !== expectedProductionRef) {
    throw new Error('staging_db_isolation_configuration_mismatch');
  }
  if (stagingRef === productionRef) throw new Error('staging_db_isolation_failed');

  const databaseRefs = [];
  for (const key of DATABASE_CONNECTION_KEYS) {
    if (!env[key]) continue;
    const ref = projectRefFromDatabaseUrl(env[key]);
    if (!ref) throw new Error(`staging_db_isolation_unconfirmed_${key.toLowerCase()}`);
    databaseRefs.push({ key, ref });
    if (ref !== stagingRef) throw new Error(`staging_db_isolation_failed_${key.toLowerCase()}`);
  }
  return { enforced: true, stagingRef, productionRef, databaseRefs };
}

module.exports = {
  DATABASE_CONNECTION_KEYS,
  projectRefFromSupabaseUrl,
  projectRefFromDatabaseUrl,
  isStagingEnvironment,
  assertStagingIsolation,
};
