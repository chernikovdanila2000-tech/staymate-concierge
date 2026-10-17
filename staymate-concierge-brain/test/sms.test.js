'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { normalizeSmsPhone, smsSegments, TurboSmsProvider, MobizonProvider, SmsNotificationService, verifyTurboWebhook, verifyMobizonWebhook } = require('../sms');

test('normalizes Ukrainian spoken numbers and rejects unusable numbers', () => {
  assert.equal(normalizeSmsPhone('050 123 45 67'), '+380501234567');
  assert.equal(normalizeSmsPhone('+380 50 123 45 67'), '+380501234567');
  assert.equal(normalizeSmsPhone('hidden'), null);
});
test('counts GSM and Ukrainian UCS-2 SMS segments correctly', () => {
  assert.deepEqual(smsSegments('a'.repeat(160)), { encoding: 'gsm7', segments: 1 });
  assert.equal(smsSegments('a'.repeat(161)).segments, 2);
  assert.deepEqual(smsSegments('Оплата бронювання'), { encoding: 'ucs2', segments: 1 });
  assert.equal(smsSegments('і'.repeat(71)).segments, 2);
});
test('TurboSMS uses documented bearer token and a <=40 char sequence_id', async () => {
  let request; const provider = new TurboSmsProvider({ turboToken: 'secret', sender: 'StayAI' }, async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ response_code: 800, response_status: 'SUCCESS_MESSAGE_ACCEPTED', response_result: [{ message_id: 'm1', response_status: 'OK' }] }) }; });
  const result = await provider.sendPaymentLink({ phone: '+380501234567', text: 'x', idempotencyKey: 'logical-key' });
  assert.equal(result.accepted, true); assert.equal(request.options.headers.Authorization, 'Bearer secret'); assert.equal(JSON.parse(request.options.body).sequence_id.length, 40);
});
test('Mobizon uses POST form data and records API messageId', async () => {
  let request; const provider = new MobizonProvider({ mobizonKey: 'secret', sender: 'StayAI' }, async (url, options) => { request = { url: String(url), options }; return { ok: true, status: 200, json: async () => ({ code: 0, data: { messageId: 77 } }) }; });
  const result = await provider.sendPaymentLink({ phone: '+380501234567', text: 'x' });
  assert.equal(result.providerMessageId, '77'); assert.match(request.url, /apiKey=secret/); assert.match(String(request.options.body), /recipient=380501234567/);
});
test('accepts only exact official webhook signature algorithms', () => {
  const turbo = { id: 'abc' }; turbo.signature = crypto.createHash('sha1').update('turbo-secretabc').digest('hex'); assert.equal(verifyTurboWebhook(turbo, 'turbo-secret'), true); assert.equal(verifyTurboWebhook(turbo, 'wrong'), false);
  const mob = { eventId: 4, attempt: 2, eventCreateTs: '2026-01-01 00:00:00' }; mob.sign = crypto.createHash('sha1').update('4|2|2026-01-01 00:00:00|mob-secret').digest('hex'); assert.equal(verifyMobizonWebhook(mob, 'mob-secret'), true); assert.equal(verifyMobizonWebhook(mob, 'wrong'), false);
});
test('never falls back after an ambiguous transport timeout', async () => {
  const calls = []; const supabase = { rpc: async (name, args) => { calls.push({ name, args }); if (name === 'sms_claim_outbox') return { data: { id: 'n1', phone: '+380501234567', text: 'x', idempotency_key: 'k' } }; return { data: null }; } };
  const service = new SmsNotificationService({ supabase, config: { enabled: true, primary: 'turbosms', fallback: 'mobizon', turboEnabled: true, mobizonEnabled: true, turboToken: 't', mobizonKey: 'm', estimatedSegmentCost: 0 }, providers: { turbosms: { sendPaymentLink: async () => { throw new Error('timeout'); } }, mobizon: { sendPaymentLink: async () => { throw new Error('must not call'); } } } });
  assert.deepEqual(await service.processOne(), { processed: true, status: 'UNKNOWN' }); assert.equal(calls.filter(c => c.name === 'sms_finish_outbox')[0].args.p_provider, 'turbosms');
});
test('fallback is used only after a definitive primary rejection', async () => {
  const calls = []; const supabase = { rpc: async (name, args) => { calls.push({ name, args }); if (name === 'sms_claim_outbox') return { data: { id: 'n1', phone: '+380501234567', text: 'x', idempotency_key: 'k' } }; return { data: null }; } };
  const service = new SmsNotificationService({ supabase, config: { enabled: true, primary: 'turbosms', fallback: 'mobizon', turboEnabled: true, mobizonEnabled: true, turboToken: 't', mobizonKey: 'm', estimatedSegmentCost: 0 }, providers: { turbosms: { sendPaymentLink: async () => ({ accepted: false, definitive: true, status: 'rejected' }) }, mobizon: { sendPaymentLink: async () => ({ accepted: true, providerMessageId: 'm2', status: 'ACCEPTED' }) } } });
  await service.processOne(); assert.equal(calls.filter(c => c.name === 'sms_finish_outbox')[0].args.p_provider, 'mobizon');
});
