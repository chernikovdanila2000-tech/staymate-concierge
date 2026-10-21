const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createInvoice, verifyIpnSignature, sortObjectKeys } = require('../nowpayments');

function fakeFetch(responses) {
  let call = 0;
  return async (url, options) => {
    const r = responses[call++];
    fakeFetch.lastCall = { url, options };
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.body,
    };
  };
}

test('createInvoice posts price/currency/order fields and the fee-paid-by-user flags', async () => {
  const fetchImpl = fakeFetch([{ body: { id: 'inv1', invoice_url: 'https://nowpayments.io/pay/inv1' } }]);
  const result = await createInvoice({
    apiKey: 'key123',
    priceAmount: 4999,
    priceCurrency: 'uah',
    orderId: 'SUBC123',
    orderDescription: 'StayAI — тариф «Старт»',
    ipnCallbackUrl: 'https://example.com/webhook/nowpayments-subscription',
    fetchImpl,
  });

  assert.deepEqual(result, { invoiceUrl: 'https://nowpayments.io/pay/inv1', id: 'inv1' });
  assert.equal(fakeFetch.lastCall.url, 'https://api.nowpayments.io/v1/invoice');
  assert.equal(fakeFetch.lastCall.options.headers['x-api-key'], 'key123');
  const body = JSON.parse(fakeFetch.lastCall.options.body);
  assert.equal(body.price_amount, 4999);
  assert.equal(body.price_currency, 'uah');
  assert.equal(body.order_id, 'SUBC123');
  assert.equal(body.ipn_callback_url, 'https://example.com/webhook/nowpayments-subscription');
  assert.equal(body.is_fixed_rate, true);
  assert.equal(body.is_fee_paid_by_user, true);
});

test('createInvoice requires an API key', async () => {
  await assert.rejects(
    () => createInvoice({ apiKey: '', priceAmount: 100, orderId: 'X', fetchImpl: fakeFetch([]) }),
    /NOWPAYMENTS_API_KEY/
  );
});

test('createInvoice surfaces a non-ok response as an error', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 400, body: { message: 'Invalid currency' } }]);
  await assert.rejects(
    () => createInvoice({ apiKey: 'key123', priceAmount: 100, orderId: 'X', fetchImpl }),
    /Invalid currency/
  );
});

test('sortObjectKeys sorts nested objects recursively, not just the top level', () => {
  const sorted = sortObjectKeys({ b: 1, a: { d: 2, c: 3 } });
  assert.equal(JSON.stringify(sorted), '{"a":{"c":3,"d":2},"b":1}');
});

test('verifyIpnSignature accepts a signature computed over the sorted payload', () => {
  const secret = 'ipn-secret';
  const payload = { order_id: 'SUBC123', payment_status: 'finished', outcome: { amount: 1, currency: 'usdttrc20' } };
  const sortedJson = JSON.stringify(sortObjectKeys(payload));
  const sig = crypto.createHmac('sha512', secret).update(sortedJson, 'utf8').digest('hex');

  // Body arrives with keys in a different order than they were signed in —
  // this is the realistic case the recursive sort exists to handle.
  const rawBody = JSON.stringify({
    payment_status: 'finished',
    outcome: { currency: 'usdttrc20', amount: 1 },
    order_id: 'SUBC123',
  });

  assert.equal(verifyIpnSignature({ rawBody, signatureHeader: sig, ipnSecret: secret }), true);
});

test('verifyIpnSignature rejects a tampered body', () => {
  const secret = 'ipn-secret';
  const payload = { order_id: 'SUBC123', payment_status: 'finished' };
  const sig = crypto
    .createHmac('sha512', secret)
    .update(JSON.stringify(sortObjectKeys(payload)), 'utf8')
    .digest('hex');

  const tamperedBody = JSON.stringify({ order_id: 'SUBC123', payment_status: 'waiting' });
  assert.equal(verifyIpnSignature({ rawBody: tamperedBody, signatureHeader: sig, ipnSecret: secret }), false);
});

test('verifyIpnSignature rejects when the secret is wrong', () => {
  const payload = { order_id: 'SUBC123', payment_status: 'finished' };
  const rawBody = JSON.stringify(payload);
  const sig = crypto
    .createHmac('sha512', 'right-secret')
    .update(JSON.stringify(sortObjectKeys(payload)), 'utf8')
    .digest('hex');

  assert.equal(verifyIpnSignature({ rawBody, signatureHeader: sig, ipnSecret: 'wrong-secret' }), false);
});

test('verifyIpnSignature rejects malformed JSON instead of throwing', () => {
  assert.equal(
    verifyIpnSignature({ rawBody: '{not json', signatureHeader: 'abc', ipnSecret: 'secret' }),
    false
  );
});

test('verifyIpnSignature returns false when required inputs are missing', () => {
  assert.equal(verifyIpnSignature({ rawBody: '', signatureHeader: 'abc', ipnSecret: 'secret' }), false);
  assert.equal(verifyIpnSignature({ rawBody: '{}', signatureHeader: '', ipnSecret: 'secret' }), false);
  assert.equal(verifyIpnSignature({ rawBody: '{}', signatureHeader: 'abc', ipnSecret: '' }), false);
});
