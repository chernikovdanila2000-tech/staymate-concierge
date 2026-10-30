const test = require('node:test');
const assert = require('node:assert/strict');
const {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  listPages,
  getPageInstagramAccount,
  subscribePageWebhooks,
  registerWhatsAppNumber,
  subscribeWabaWebhooks,
} = require('../meta-oauth');

function fakeFetch(responses) {
  let call = 0;
  return async (url, options) => {
    const r = responses[call++];
    fakeFetch.calls = fakeFetch.calls || [];
    fakeFetch.calls.push({ url, options });
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.body,
    };
  };
}

test.beforeEach(() => { fakeFetch.calls = []; });

test('exchangeCodeForToken calls oauth/access_token with an empty redirect_uri by default', async () => {
  const fetchImpl = fakeFetch([{ body: { access_token: 'short-lived', expires_in: 3600 } }]);
  const result = await exchangeCodeForToken({ code: 'abc', appId: 'app1', appSecret: 'secret1', fetchImpl });
  assert.deepEqual(result, { accessToken: 'short-lived', expiresIn: 3600 });
  const url = new URL(fakeFetch.calls[0].url);
  assert.equal(url.pathname, '/v24.0/oauth/access_token');
  assert.equal(url.searchParams.get('client_id'), 'app1');
  assert.equal(url.searchParams.get('client_secret'), 'secret1');
  assert.equal(url.searchParams.get('code'), 'abc');
  assert.equal(url.searchParams.get('redirect_uri'), '');
});

test('exchangeForLongLivedToken uses grant_type=fb_exchange_token', async () => {
  const fetchImpl = fakeFetch([{ body: { access_token: 'long-lived', expires_in: 5184000 } }]);
  const result = await exchangeForLongLivedToken({ shortLivedToken: 'short-lived', appId: 'app1', appSecret: 'secret1', fetchImpl });
  assert.deepEqual(result, { accessToken: 'long-lived', expiresIn: 5184000 });
  const url = new URL(fakeFetch.calls[0].url);
  assert.equal(url.searchParams.get('grant_type'), 'fb_exchange_token');
  assert.equal(url.searchParams.get('fb_exchange_token'), 'short-lived');
});

test('listPages returns the data array from /me/accounts', async () => {
  const pages = [{ id: 'p1', name: 'Hotel A', access_token: 'tok1' }];
  const fetchImpl = fakeFetch([{ body: { data: pages } }]);
  const result = await listPages({ userToken: 'user-token', fetchImpl });
  assert.deepEqual(result, pages);
  const url = new URL(fakeFetch.calls[0].url);
  assert.equal(url.pathname, '/v24.0/me/accounts');
  assert.equal(url.searchParams.get('access_token'), 'user-token');
});

test('listPages returns an empty array when there is no data field', async () => {
  const fetchImpl = fakeFetch([{ body: {} }]);
  const result = await listPages({ userToken: 'user-token', fetchImpl });
  assert.deepEqual(result, []);
});

test('getPageInstagramAccount returns the linked account when present', async () => {
  const fetchImpl = fakeFetch([{ body: { instagram_business_account: { id: 'ig1', username: 'hotel_a' } } }]);
  const result = await getPageInstagramAccount({ pageId: 'p1', pageToken: 'tok1', fetchImpl });
  assert.deepEqual(result, { id: 'ig1', username: 'hotel_a' });
});

test('getPageInstagramAccount returns null when the page has no linked Instagram account', async () => {
  const fetchImpl = fakeFetch([{ body: {} }]);
  const result = await getPageInstagramAccount({ pageId: 'p1', pageToken: 'tok1', fetchImpl });
  assert.equal(result, null);
});

test('subscribePageWebhooks posts to {pageId}/subscribed_apps with the expected fields', async () => {
  const fetchImpl = fakeFetch([{ body: { success: true } }]);
  await subscribePageWebhooks({ pageId: 'p1', pageToken: 'tok1', fetchImpl });
  const call = fakeFetch.calls[0];
  assert.ok(call.url.endsWith('/p1/subscribed_apps'));
  assert.equal(call.options.method, 'POST');
  const body = new URLSearchParams(call.options.body);
  assert.equal(body.get('subscribed_fields'), 'messages,messaging_postbacks,message_reads');
  assert.equal(body.get('access_token'), 'tok1');
});

test('registerWhatsAppNumber posts messaging_product and pin to {phoneNumberId}/register', async () => {
  const fetchImpl = fakeFetch([{ body: { success: true } }]);
  await registerWhatsAppNumber({ phoneNumberId: 'phone1', accessToken: 'wa-token', pin: '123456', fetchImpl });
  const call = fakeFetch.calls[0];
  assert.ok(call.url.endsWith('/phone1/register'));
  const body = new URLSearchParams(call.options.body);
  assert.equal(body.get('messaging_product'), 'whatsapp');
  assert.equal(body.get('pin'), '123456');
});

test('subscribeWabaWebhooks posts to {wabaId}/subscribed_apps', async () => {
  const fetchImpl = fakeFetch([{ body: { success: true } }]);
  await subscribeWabaWebhooks({ wabaId: 'waba1', accessToken: 'wa-token', fetchImpl });
  const call = fakeFetch.calls[0];
  assert.ok(call.url.endsWith('/waba1/subscribed_apps'));
  assert.equal(call.options.method, 'POST');
});

test('a Graph API error response rejects with the error message, not a thrown parse failure', async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 400, body: { error: { message: 'Invalid OAuth access token' } } }]);
  await assert.rejects(
    () => listPages({ userToken: 'bad-token', fetchImpl }),
    /Invalid OAuth access token/
  );
});

test('fetchImpl must be a function', async () => {
  await assert.rejects(
    () => listPages({ userToken: 'x', fetchImpl: null }),
    /fetch недоступний/
  );
});
