'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertAdapter, createMockExternalPmsAdapter } = require('../inventory-adapter');

test('inventory adapter contract fails closed when an operation is missing', () => {
  assert.throws(() => assertAdapter({ getAvailability() {} }), /createHold/);
});

test('mock external PMS never exposes or releases another property hold', async () => {
  const inventory = new Map([['one', { roomType: 'standard', available: 1 }]]);
  const a = createMockExternalPmsAdapter({ propertyId: 'hotel-a', inventory });
  const b = createMockExternalPmsAdapter({ propertyId: 'hotel-b', inventory });
  assert.equal((await a.createHold({ bookingId: 'A1', roomType: 'standard' })).ok, true);
  assert.equal((await b.createHold({ bookingId: 'B1', roomType: 'standard' })).ok, false);
  await assert.rejects(() => b.releaseHold({ bookingId: 'A1' }), /not found/);
  assert.equal((await a.confirmBooking({ bookingId: 'A1' })).ok, true);
});
