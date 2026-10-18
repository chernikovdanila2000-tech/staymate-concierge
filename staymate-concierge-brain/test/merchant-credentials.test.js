'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getMonobankMerchant } = require('../merchant-credentials');

test('a missing property merchant never falls back to a process-wide acquiring token', async () => {
  const previous = process.env.MONOBANK_ACQUIRING_TOKEN;
  process.env.MONOBANK_ACQUIRING_TOKEN = 'must-not-be-used';
  const db = {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
  };
  try {
    assert.equal(await getMonobankMerchant(db, 'hotel-a'), null);
  } finally {
    if (previous === undefined) delete process.env.MONOBANK_ACQUIRING_TOKEN;
    else process.env.MONOBANK_ACQUIRING_TOKEN = previous;
  }
});

test('a malformed merchant row cannot cross a property boundary', async () => {
  const db = {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { property_id: 'hotel-b', merchant_id: 'mono:hotel-b', enabled: true, disabled_at: null, credentials: {} }, error: null,
    }) }) }) }) }),
  };
  assert.equal(await getMonobankMerchant(db, 'hotel-a'), null);
});
