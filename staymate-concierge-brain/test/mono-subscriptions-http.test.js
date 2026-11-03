'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createMonoSubscriptionHttp } = require('../mono-subscriptions-http');
const { MonoSubscriptionError } = require('../mono-subscriptions');

function req(method, url, json, headers = {}) {
  const stream = Readable.from(json === undefined ? [] : [Buffer.from(JSON.stringify(json))]);
  stream.method = method; stream.url = url; stream.headers = headers;
  return stream;
}
function res() {
  return {
    statusCode: undefined, headers: undefined, body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(data) { this.body = data || ''; },
    get json() { return this.body ? JSON.parse(this.body) : {}; },
  };
}
const createService = {
  async createSubscriptionInvoice(args) {
    assert.equal(args.authToken, 'session_abc');
    assert.equal(args.propertyId, 'hotel_1');
    assert.equal(args.plan, 'start');
    return { invoiceUrl: 'https://pay.mbnk.biz/p2_test', priceUah: 4999 };
  },
  async receiveSignedWebhook({ rawBody, xSign }) {
    assert.equal(xSign, 'valid-test-signature');
    assert.equal(JSON.parse(rawBody.toString()).invoiceId, 'p2_abc');
    return { acknowledged: true, credited: true };
  },
};

test('subscription create routes with Bearer auth, returning real mono payment URL', async () => {
  const handler = createMonoSubscriptionHttp(createService);
  const response = res();
  assert.equal(await handler(req('POST', '/api/create-subscription-invoice',
    { propertyId: 'hotel_1', plan: 'start' },
    { authorization: 'Bearer session_abc', origin: 'https://stayai.online' }), response), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.invoiceUrl, 'https://pay.mbnk.biz/p2_test');
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://stayai.online');
});

test('cross-site origin cannot read invoice response', async () => {
  const handler = createMonoSubscriptionHttp(createService);
  const response = res();
  await handler(req('POST', '/api/create-subscription-invoice',
    { propertyId: 'hotel_1', plan: 'start' },
    { authorization: 'Bearer session_abc', origin: 'https://malicious.example' }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Access-Control-Allow-Origin'], undefined);
});

test('preflight supports Authorization only from StayAI origin', async () => {
  const handler = createMonoSubscriptionHttp(createService);
  const r = res();
  await handler(req('OPTIONS', '/api/create-subscription-invoice', undefined,
    { origin: 'https://stayai.online' }), r);
  assert.equal(r.statusCode, 204);
  assert.match(r.headers['Access-Control-Allow-Headers'], /authorization/);
});

test('webhook requires POST but never allows browser origin', async () => {
  const handler = createMonoSubscriptionHttp(createService);
  const r = res();
  await handler(req('POST', '/webhook/mono-subscription',
    { invoiceId: 'p2_abc', status: 'success' },
    { 'x-sign': 'valid-test-signature' }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(r.headers['Access-Control-Allow-Origin'], undefined);
});

test('no auth token gets 401 from payment service', async () => {
  const handler = createMonoSubscriptionHttp({
    ...createService,
    async createSubscriptionInvoice({ authToken }) {
      if (!authToken) throw new MonoSubscriptionError('Потрібна авторизація.', 401);
    },
  });
  const r = res();
  await handler(req('POST', '/api/create-subscription-invoice',
    { propertyId: 'hotel_1', plan: 'start' }), r);
  assert.equal(r.statusCode, 401);
  assert.equal(r.json.error, 'Потрібна авторизація.');
});

test('unknown route remains for regular StayAI router', async () => {
  const handler = createMonoSubscriptionHttp(createService);
  assert.equal(await handler(req('GET', '/health'), res()), false);
});
