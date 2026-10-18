'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectRefFromSupabaseUrl, projectRefFromDatabaseUrl, assertStagingIsolation } = require('../environment-isolation');

function isolatedEnv(overrides = {}) {
  return {
    REQUIRE_STAGING_DB_ISOLATION: 'true',
    SUPABASE_URL: 'https://stage-ref.supabase.co',
    PRODUCTION_SUPABASE_URL: 'https://prod-ref.supabase.co',
    STAGING_SUPABASE_PROJECT_REF: 'stage-ref',
    PRODUCTION_SUPABASE_PROJECT_REF: 'prod-ref',
    ...overrides,
  };
}

test('extracts only a Supabase project reference from a URL', () => {
  assert.equal(projectRefFromSupabaseUrl('https://stage-ref.supabase.co'), 'stage-ref');
  assert.equal(projectRefFromSupabaseUrl('postgres://x'), '');
  assert.equal(projectRefFromDatabaseUrl('postgresql://postgres:pw@db.stage-ref.supabase.co:5432/postgres'), 'stage-ref');
  assert.equal(projectRefFromDatabaseUrl('postgresql://postgres.stage-ref:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres'), 'stage-ref');
  assert.equal(projectRefFromDatabaseUrl('postgresql://postgres:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?options=project%3Dstage-ref'), 'stage-ref');
  assert.equal(projectRefFromDatabaseUrl('postgresql://postgres:pw@evil.example.com/postgres?options=project%3Dstage-ref'), '');
  assert.equal(projectRefFromDatabaseUrl('postgresql://postgres.stage-ref:pw@pooler.supabase.com:6543/postgres'), '');
  assert.equal(projectRefFromDatabaseUrl('postgresql://postgres.stage-ref:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?options=project%3Dprod-ref'), '');
  assert.equal(projectRefFromDatabaseUrl('postgresql://postgres.prod-ref:pw@db.stage-ref.supabase.co:5432/postgres'), '');
});
test('staging isolation fails closed for missing or shared project refs', () => {
  assert.throws(() => assertStagingIsolation({ REQUIRE_STAGING_DB_ISOLATION: 'true', SUPABASE_URL: 'https://same.supabase.co' }), /unconfirmed/);
  assert.throws(() => assertStagingIsolation(isolatedEnv({ SUPABASE_URL: 'https://prod-ref.supabase.co' })), /configuration_mismatch/);
  assert.throws(() => assertStagingIsolation(isolatedEnv({ DATABASE_URL: 'postgresql://postgres:pw@db.prod-ref.supabase.co:5432/postgres' })), /failed_database_url/);
  assert.throws(() => assertStagingIsolation(isolatedEnv({ DIRECT_URL: 'postgresql://localhost/postgres' })), /unconfirmed_direct_url/);
  assert.deepEqual(assertStagingIsolation(isolatedEnv()), { enforced: true, stagingRef: 'stage-ref', productionRef: 'prod-ref', databaseRefs: [] });
});
test('a Railway staging environment enforces isolation even if the optional flag is absent', () => {
  assert.throws(() => assertStagingIsolation({ RAILWAY_ENVIRONMENT_NAME: 'voice-realtime-test' }), /unconfirmed/);
  assert.equal(assertStagingIsolation({ NODE_ENV: 'production' }).enforced, false);
});
