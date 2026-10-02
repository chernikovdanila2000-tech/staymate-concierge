const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyMonobankToken, fetchMonobankStatement, findMatchingTransaction } = require('../monobank');

function fakeFetch(responses) {
  let call = 0;
  return async (url) => {
    const r = responses[call++];
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {})),
    };
  };
}

test('verifyMonobankToken accepts a working token and returns the account name', async () => {
  const result = await verifyMonobankToken('tok123', {
    fetchImpl: fakeFetch([{ body: { name: 'FOP Ivanenko' } }]),
  });
  assert.deepEqual(result, { ok: true, name: 'FOP Ivanenko' });
});

test('verifyMonobankToken rejects an invalid token without throwing', async () => {
  const result = await verifyMonobankToken('bad-token', {
    fetchImpl: fakeFetch([{ ok: false, status: 403 }]),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /403/);
});

test('verifyMonobankToken requires a token up front', async () => {
  const result = await verifyMonobankToken('', { fetchImpl: fakeFetch([]) });
  assert.equal(result.ok, false);
});

test('fetchMonobankStatement calls the statement endpoint with the given range', async () => {
  let requestedUrl;
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => [{ amount: 1000 }] };
  };
  const data = await fetchMonobankStatement('tok123', { fromSeconds: 100, toSeconds: 200, fetchImpl });
  assert.equal(requestedUrl, 'https://api.monobank.ua/personal/statement/0/100/200');
  assert.deepEqual(data, [{ amount: 1000 }]);
});

test('fetchMonobankStatement clamps the range to Monobank\'s 31-day limit', async () => {
  let requestedUrl;
  const to = 1000000;
  const from = to - 40 * 24 * 60 * 60; // 40 днів тому — довше за ліміт
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => [] };
  };
  await fetchMonobankStatement('tok123', { fromSeconds: from, toSeconds: to, fetchImpl });
  const clampedFrom = to - 31 * 24 * 60 * 60;
  assert.equal(requestedUrl, `https://api.monobank.ua/personal/statement/0/${clampedFrom}/${to}`);
});

test('fetchMonobankStatement surfaces a non-ok response as an error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'too many requests' });
  await assert.rejects(
    () => fetchMonobankStatement('tok123', { fetchImpl }),
    /429/
  );
});

test('findMatchingTransaction matches by exact amount (kopecks) and reference in the comment', () => {
  const transactions = [
    { amount: 50000, comment: 'оплата за номер SM-AB12X' },
    { amount: 50000, comment: 'щось інше SM-ZZ999' },
  ];
  const match = findMatchingTransaction(transactions, { totalPrice: 500, reference: 'SM-AB12X' });
  assert.equal(match, transactions[0]);
});

test('findMatchingTransaction matches by amount alone when no reference is given', () => {
  const transactions = [{ amount: 20000, comment: '' }];
  const match = findMatchingTransaction(transactions, { totalPrice: 200 });
  assert.equal(match, transactions[0]);
});

test('findMatchingTransaction ignores outgoing (negative) and mismatched amounts', () => {
  const transactions = [
    { amount: -50000, comment: 'SM-AB12X' },
    { amount: 49999, comment: 'SM-AB12X' },
  ];
  const match = findMatchingTransaction(transactions, { totalPrice: 500, reference: 'SM-AB12X' });
  assert.equal(match, null);
});

test('findMatchingTransaction returns null when the reference is not in the comment', () => {
  const transactions = [{ amount: 50000, comment: 'no code here' }];
  const match = findMatchingTransaction(transactions, { totalPrice: 500, reference: 'SM-AB12X' });
  assert.equal(match, null);
});
