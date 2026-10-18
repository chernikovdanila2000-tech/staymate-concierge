'use strict';

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_KEY ||= 'test-key';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validStayDates, bookingRequestKey, nightsBetween } = require('../tools');

test('booking dates are strict, chronological UTC calendar dates', () => {
  assert.equal(validStayDates('2026-10-20', '2026-10-22'), true);
  assert.equal(validStayDates('2026-10-20', '2026-10-20'), false);
  assert.equal(validStayDates('20-10-2026', '22-10-2026'), false);
  assert.equal(nightsBetween('2026-10-20', '2026-10-22'), 2);
});

test('booking idempotency key is stable per tenant and call but isolated across tenants', () => {
  const base = { propertyId: 'hotel-a', channel: 'phone', chatId: 'call-1', roomType: 'standard', checkIn: '2026-10-20', checkOut: '2026-10-22', guestName: 'Guest', guestContact: '+380501234567' };
  assert.equal(bookingRequestKey(base), bookingRequestKey({ ...base }));
  assert.notEqual(bookingRequestKey(base), bookingRequestKey({ ...base, propertyId: 'hotel-b' }));
  assert.notEqual(bookingRequestKey(base), bookingRequestKey({ ...base, checkOut: '2026-10-23' }));
});
