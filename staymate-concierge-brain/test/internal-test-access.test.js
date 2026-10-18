'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hasInternalTestAccess } = require('../internal-test-access');

const env = { INTERNAL_TEST_CHAT_ENABLED: 'true', INTERNAL_TEST_CHAT_TOKEN: 'staging-only-test-token' };

test('internal test chat is fail-closed by default and accepts only its server token', () => {
  assert.equal(hasInternalTestAccess({}, {}), false);
  assert.equal(hasInternalTestAccess({ authorization: 'Bearer staging-only-test-token' }, env), true);
  assert.equal(hasInternalTestAccess({ authorization: 'Bearer wrong' }, env), false);
  assert.equal(hasInternalTestAccess({ 'x-internal-test-token': 'staging-only-test-token' }, env), true);
});
