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

test('ledger migration reserves idempotency before state changes and hardens invoice binding', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'payment-ledger-migration.sql'), 'utf8');
  const reserve = sql.indexOf("values(p_event_key,'monobank_acquiring'");
  const bookingLock = sql.indexOf('select * into b from public.bookings');
  assert.ok(reserve >= 0 && reserve < bookingLock, 'event key is reserved before booking state changes');
  assert.match(sql, /and status='pending_payment' and payment_state='PENDING'/i);
  assert.match(sql, /get diagnostics v_updated = row_count/i);
  assert.match(sql, /v_outcome := 'requires_review'/i);
  assert.match(sql, /p_merchant_id=\('mono:' \|\| p_property_id\)/i);
  assert.match(sql, /payment_merchant_id=\('mono:' \|\| p_property_id\)/i);
  assert.match(sql, /hold_expires_at is null or hold_expires_at >= now\(\)/i);
});
