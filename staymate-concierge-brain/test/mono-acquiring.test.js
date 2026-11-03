'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  MonoApiError, checkMerchantToken, createInvoice, getInvoiceStatus,
  getWebhookPublicKey, verifyWebhookSignature, matchesPaidInvoice,
} = require('../mono-acquiring');

test('merchant details verified with the correct token header (read-only)', async () => {
  const r = await checkMerchantToken('secret-test-value', {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.monobank.ua/api/merchant/details');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers['X-Token'], 'secret-test-value');
      return { ok: true, json: async () => ({ merchantId: 'merch123', merchantName: 'StayAI' }) };
    },
  });
  assert.deepEqual(r, { merchantId: 'merch123', merchantName: 'StayAI' });
});

test('403 token rejection cannot leak the provided token', async () => {
  const rejected = 'partner-secret';
  await assert.rejects(
    checkMerchantToken(rejected, { fetchImpl: async () => ({ ok: false, status: 403 }) }),
    (error) => error instanceof MonoApiError && error.status === 403 &&
      !error.message.includes(rejected)
  );
});

test('UAH subscription invoice with reference, secure webhook and correct amount', async () => {
  const r = await createInvoice({
    token: 'test-merchant-token',
    amountKopecks: 499900,
    reference: 'SUBABC123',
    destination: 'StayAI monthly Start',
    webHookUrl: 'https://example.com/webhook/mono-subscription',
    redirectUrl: 'https://stayai.online/cabinet/',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.monobank.ua/api/merchant/invoice/create');
      assert.equal(options.method, 'POST');
      const b = JSON.parse(options.body);
      assert.equal(b.amount, 499900);
      assert.equal(b.ccy, 980);
      assert.equal(b.paymentType, 'debit');
      assert.equal(b.merchantPaymInfo.reference, 'SUBABC123');
      assert.equal(b.webHookUrl, 'https://example.com/webhook/mono-subscription');
      return {
        ok: true,
        json: async () => ({
          invoiceId: 'p2_abc123',
          pageUrl: 'https://pay.mbnk.biz/p2_abc123',
        }),
      };
    },
  });
  assert.deepEqual(r, { invoiceId: 'p2_abc123', invoiceUrl: 'https://pay.mbnk.biz/p2_abc123' });
});

test('invalid prices, callback and spoofed payment links are rejected', async () => {
  await assert.rejects(createInvoice({ token: 'x', amountKopecks: 0, reference: 'SUBABC' }), /positive integer/);
  await assert.rejects(createInvoice({ token: 'x', amountKopecks: 100, reference: 'SUBABC', webHookUrl: 'http://localhost/webhook' }), /HTTPS/);
  await assert.rejects(createInvoice({
    token: 'x', amountKopecks: 100, reference: 'SUBABC',
    fetchImpl: async () => ({ ok: true, json: async () => ({
      invoiceId: 'p2_abc123', pageUrl: 'https://pay.mbnk.biz.attacker.test/',
    }) }),
  }), /invalid/);
});

test('query paid invoice status uses the supplied invoice ID', async () => {
  const status = await getInvoiceStatus({ token: 'test',
    invoiceId: 'p2_abc123',
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.monobank.ua/api/merchant/invoice/status?invoiceId=p2_abc123');
      return { ok: true, json: async () => ({ status: 'success' }) };
    },
  });
  assert.equal(status.status, 'success');
});

test('fetches webhook ECDSA public key', async () => {
  const key = await getWebhookPublicKey({ token: 'test',
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.monobank.ua/api/merchant/pubkey');
      return { ok: true, json: async () => ({ key: 'cHVibGlj' }) };
    },
  });
  assert.equal(key, 'cHVibGlj');
});

test('validates webhook signature only on unmodified raw bytes', () => {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyBase64 = Buffer.from(kp.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
  const rawBody = Buffer.from('{"invoiceId":"p2_abc123","status":"success"}');
  const signatureBase64 = crypto.sign('sha256', rawBody, kp.privateKey).toString('base64');
  assert.equal(verifyWebhookSignature({ publicKeyBase64, rawBody, signatureBase64 }), true);
  assert.equal(verifyWebhookSignature({ publicKeyBase64, rawBody: Buffer.from(rawBody.toString() + ' '), signatureBase64 }), false);
  assert.equal(verifyWebhookSignature({ publicKeyBase64, rawBody, signatureBase64: 'invalid' }), false);
});

test('payment acceptance requires exact invoice ID, reference, amount, currency and status', () => {
  const expected = { invoiceId: 'p2_abc123', reference: 'SUBABC123', amountKopecks: 499900 };
  const valid = { invoiceId: 'p2_abc123', reference: 'SUBABC123', amount: 499900, ccy: 980, status: 'success' };
  assert.equal(matchesPaidInvoice(valid, expected), true);
  for (const key of Object.keys(valid)) {
    assert.equal(matchesPaidInvoice({ ...valid, [key]: 'bad' }, expected), false);
  }
});
