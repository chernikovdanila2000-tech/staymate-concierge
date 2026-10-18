'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { expectedKopecks, isExpectedAcquiringSuccess } = require('../payment-validation');

const booking = { property_id: 'hotel-a', booking_id: 'BKABC', total_price: 1234.56, payment_reference: 'invoice-a', status: 'pending_payment' };
const event = { status: 'success', invoiceId: 'invoice-a', reference: 'BKABC', amount: 123456, finalAmount: 123456, ccy: 980 };

test('payment matching requires the exact booking invoice, UAH amount and currency', () => {
  assert.equal(expectedKopecks(1234.56), 123456);
  assert.equal(isExpectedAcquiringSuccess(event, booking), true);
  assert.equal(isExpectedAcquiringSuccess({ ...event, invoiceId: 'invoice-b' }, booking), false);
  assert.equal(isExpectedAcquiringSuccess({ ...event, reference: 'BKOTHER' }, booking), false);
  assert.equal(isExpectedAcquiringSuccess({ ...event, amount: 123455 }, booking), false);
  assert.equal(isExpectedAcquiringSuccess({ ...event, ccy: 840 }, booking), false);
  assert.equal(isExpectedAcquiringSuccess({ ...event, finalAmount: 1 }, booking), false);
});
