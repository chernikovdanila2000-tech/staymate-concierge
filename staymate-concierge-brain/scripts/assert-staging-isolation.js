'use strict';
const { assertStagingIsolation } = require('../environment-isolation');
try {
  const result = assertStagingIsolation({ ...process.env, REQUIRE_STAGING_DB_ISOLATION: 'true' });
  console.log(`staging database isolation verified (${result.stagingRef} != ${result.productionRef})`);
} catch (error) {
  console.error(`Refusing staging migration/deployment: ${error.message}`);
  process.exitCode = 1;
}
