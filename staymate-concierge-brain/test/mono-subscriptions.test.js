'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMonoSubscriptions, MonoSubscriptionError } = require('../mono-subscriptions');

function makeDb({ userId = 'owner-1', property = { property_id: 'hotel-1', hotel_name: 'Hotel 1' },
                  order, finalize = 'paid' } = {}) {
  const calls = { inserted: null, rpc: null, propertyFilter: {} };
  const db = {
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) },
    from(table) {
      const chain = {
        select() { return this; },
        eq(key, val) {
          if (table === 'properties') calls.propertyFilter[key] = val;
          return this;
        },
        async maybeSingle() {
          return { data: table === 'properties' ? property : order, error: null };
        },
        async insert(row) { calls.inserted = { ...row }; return { error: null }; },
      };
      return chain;
    },
    async rpc(name, params) {
      calls.rpc = { name, params };
      return { data: [{ result: finalize }], error: null };
    },
  };
  return { db, calls };
}

function fakeMono() {
  return {
    createInvoice: async () => ({ invoiceId: 'p2_abc123', invoiceUrl: 'https://pay.mbnk.biz/p2_abc123' }),
    getWebhookPublicKey: async () => 'cHVibGlj',
    verifyWebhookSignature: () => true,
    getInvoiceStatus: async () => ({ invoiceId: 'p2_abc123', reference: 'SUBABC123', status: 'success', ccy: 980, amount: 499900 }),
    matchesPaidInvoice(event, expected) {
      return event.invoiceId === expected.invoiceId && event.reference === expected.reference &&
        event.status === 'success' && event.ccy === 980 && event.amount === expected.amountKopecks;
    },
  };
}

const config = { merchantToken: 'dummy-token', apiBaseUrl: 'https://stayai-production-backend-production.up.railway.app' };

test('owner authorization and property owner must both match before invoice', async () => {
  const { db, calls } = makeDb();
  const service = createMonoSubscriptions({ ...config, db, mono: fakeMono() });
  await assert.rejects(service.createSubscriptionInvoice({ propertyId: 'hotel-1', plan: 'start' }), e =>
    e instanceof MonoSubscriptionError && e.statusCode === 401);
  await service.createSubscriptionInvoice({ authToken: 'my-session-token', propertyId: 'hotel-1', plan: 'start' });
  assert.equal(calls.propertyFilter.property_id, 'hotel-1');
  assert.equal(calls.propertyFilter.owner_id, 'owner-1');
  assert.equal(calls.inserted.payment_provider, 'monobank');
  assert.equal(calls.inserted.amount_uah, 4999);
  assert.equal(calls.inserted.mono_invoice_id, 'p2_abc123');
  assert.equal(calls.inserted.is_trial_card, false);
});

test('another hotel cannot be charged under the logged-in owner', async () => {
  const { db, calls } = makeDb({ property: null });
  let created = false;
  const mono = { ...fakeMono(), createInvoice: async () => { created = true; } };
  const service = createMonoSubscriptions({ ...config, db, mono });
  await assert.rejects(service.createSubscriptionInvoice({
    authToken: 'session', propertyId: 'another-hotel', plan: 'pro',
  }), e => e.statusCode === 403);
  assert.equal(created, false);
  assert.equal(calls.inserted, null);
});

test('verified success calls atomic payment finalization RPC with amount and reference', async () => {
  const { db, calls } = makeDb({ order: {
    order_id: 'SUBABC123', property_id: 'hotel-1', amount_uah: 4999,
    status: 'pending', payment_provider: 'monobank', mono_invoice_id: 'p2_abc123',
    is_trial_card: false,
  } });
  const service = createMonoSubscriptions({ ...config, db, mono: fakeMono() });
  const r = await service.receiveSignedWebhook({
    rawBody: Buffer.from(JSON.stringify({ invoiceId: 'p2_abc123', status: 'success' })),
    xSign: 'signature',
  });
  assert.equal(r.credited, true);
  assert.equal(calls.rpc.name, 'finalize_mono_subscription');
  assert.deepEqual(calls.rpc.params, { p_invoice_id: 'p2_abc123', p_reference: 'SUBABC123', p_amount_kopecks: 499900 });
});

test('duplicate webhook cannot credit the subscription again', async () => {
  const { db } = makeDb({ finalize: 'already_paid', order: {
    order_id: 'SUBABC123', property_id: 'hotel-1', amount_uah: 4999,
    status: 'paid', payment_provider: 'monobank', mono_invoice_id: 'p2_abc123',
    is_trial_card: false,
  } });
  const service = createMonoSubscriptions({ ...config, db, mono: fakeMono() });
  const r = await service.receiveSignedWebhook({
    rawBody: JSON.stringify({ invoiceId: 'p2_abc123', status: 'success' }),
    xSign: 'signature',
  });
  assert.equal(r.credited, false);
  assert.equal(r.duplicate, true);
});

test('invalid webhook signature is rejected before database lookup', async () => {
  const { db, calls } = makeDb();
  const service = createMonoSubscriptions({
    ...config, db, mono: { ...fakeMono(), verifyWebhookSignature: () => false },
  });
  await assert.rejects(service.receiveSignedWebhook({
    rawBody: '{"invoiceId":"p2_abc123","status":"success"}',
    xSign: 'bad',
  }), e => e.statusCode === 401);
  assert.equal(calls.rpc, null);
});

test('acquiring invoice mismatch cannot activate subscription', async () => {
  const { db, calls } = makeDb({ order: {
    order_id: 'SUBABC123', property_id: 'hotel-1', amount_uah: 4999,
    status: 'pending', payment_provider: 'monobank', mono_invoice_id: 'p2_abc123',
    is_trial_card: false,
  } });
  const service = createMonoSubscriptions({ ...config, db, mono: {
    ...fakeMono(), getInvoiceStatus: async () =>
      ({ invoiceId: 'p2_abc123', reference: 'SUBABC123', status: 'success', ccy: 980, amount: 1 }),
  } });
  await assert.rejects(service.receiveSignedWebhook({
    rawBody: '{"invoiceId":"p2_abc123","status":"success"}', xSign: 'signature',
  }), e => e.statusCode === 409);
  assert.equal(calls.rpc, null);
});
