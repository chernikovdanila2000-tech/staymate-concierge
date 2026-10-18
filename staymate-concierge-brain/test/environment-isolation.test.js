'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectRefFromSupabaseUrl, assertStagingIsolation } = require('../environment-isolation');

test('extracts only a Supabase project reference from a URL', () => {
  assert.equal(projectRefFromSupabaseUrl('https://stage-ref.supabase.co'), 'stage-ref');
  assert.equal(projectRefFromSupabaseUrl('postgres://x'), '');
});
test('staging isolation fails closed for missing or shared project refs', () => {
  assert.throws(() => assertStagingIsolation({ REQUIRE_STAGING_DB_ISOLATION: 'true', SUPABASE_URL: 'https://same.supabase.co' }), /unconfirmed/);
  assert.throws(() => assertStagingIsolation({ REQUIRE_STAGING_DB_ISOLATION: 'true', SUPABASE_URL: 'https://same.supabase.co', PRODUCTION_SUPABASE_URL: 'https://same.supabase.co' }), /failed/);
  assert.deepEqual(assertStagingIsolation({ REQUIRE_STAGING_DB_ISOLATION: 'true', SUPABASE_URL: 'https://stage.supabase.co', PRODUCTION_SUPABASE_URL: 'https://prod.supabase.co' }), { enforced: true, stagingRef: 'stage', productionRef: 'prod' });
});
