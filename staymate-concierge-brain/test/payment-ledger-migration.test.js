'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('payment service-role follow-up grants only server access to sensitive payment operations', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'payment-ledger-service-role-grants.sql'), 'utf8');
  assert.match(sql, /revoke all on public\.payment_merchants, public\.payment_events from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update on public\.payment_merchants to service_role/i);
  assert.match(sql, /grant execute on function public\.payment_record_monobank_event[\s\S]*to service_role/i);
  assert.match(sql, /grant execute on function public\.booking_bind_monobank_merchant[\s\S]*to service_role/i);
  assert.match(sql, /grant execute on function public\.booking_attach_monobank_invoice[\s\S]*to service_role/i);
});
