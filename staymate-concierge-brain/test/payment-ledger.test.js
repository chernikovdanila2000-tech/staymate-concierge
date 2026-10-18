'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { eventKey, payloadHash, recordMonobankEvent } = require('../payment-ledger');

const event = { invoiceId: 'inv-a', reference: 'BK-A', status: 'success', amount: 10000, finalAmount: 10000, ccy: 980, modifiedDate: '2026-10-18T10:00:00Z' };

test('payment event key is stable for a webhook retransmission and differs for a state change', () => {
  assert.equal(eventKey(event), eventKey({ ...event }));
  assert.equal(eventKey(event), eventKey({ ...event, modifiedDate: '2026-10-18T10:01:00Z' }));
  assert.notEqual(eventKey(event), eventKey({ ...event, status: 'failure' }));
  assert.equal(payloadHash('one'), payloadHash('one'));
});

test('ledger rejects an event that is not bound to one booking and merchant', async () => {
  const db = { rpc: async () => ({ data: null, error: null }) };
  await assert.rejects(() => recordMonobankEvent(db, { property_id: 'hotel-a' }, event, { source: 'webhook', rawBody: '{}' }), /binding_required/);
  await assert.rejects(() => recordMonobankEvent(db, { property_id: 'hotel-a', booking_id: 'BK-A', payment_merchant_id: 'mono:hotel-a' }, event, { source: 'other', rawBody: '{}' }), /invalid_payment_event_source/);
});

test('ledger RPC receives the exact tenant, merchant and invoice binding', async () => {
  let call;
  const db = { rpc: async (name, args) => { call = { name, args }; return { data: { outcome: 'paid' }, error: null }; } };
  const booking = { property_id: 'hotel-a', booking_id: 'BK-A', payment_merchant_id: 'mono:hotel-a' };
  const result = await recordMonobankEvent(db, booking, event, { source: 'webhook', rawBody: JSON.stringify(event) });
  assert.equal(result.outcome, 'paid');
  assert.equal(call.name, 'payment_record_monobank_event');
  assert.equal(call.args.p_property_id, 'hotel-a');
  assert.equal(call.args.p_merchant_id, 'mono:hotel-a');
  assert.equal(call.args.p_invoice_id, 'inv-a');
  assert.equal(call.args.p_source, 'webhook');
});
