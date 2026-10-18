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
test('a normal booking SMS is queued without a payment URL or Monobank dependency', async () => {
  let call; const service = new SmsNotificationService({ supabase: { rpc: async (name, args) => { call = { name, args }; return { data: { ok: true, status: 'QUEUED' } }; } }, config: { enabled: true } });
  const result = await service.createBookingSms({ propertyId: 'hotel-a', bookingId: 'BK1', phone: '0501234567', consent: true, text: 'StayAI: Ваше бронювання створено.' });
  assert.equal(result.ok, true); assert.equal(call.name, 'sms_queue_transactional'); assert.equal(call.args.p_phone, '+380501234567');
});


test('staging voice test SMS is accepted without a booking or invoice', async () => {
  const calls = [];
  const service = new SmsNotificationService({ supabase: { rpc: async (name, args) => { calls.push({ name, args }); if (name === 'sms_prepare_staging_test') return { data: { ok: true, notification_id: 'n-test', status: 'PROCESSING', job: { id: 'n-test', phone: '+380501234567', text: 'StayAI: Тестове SMS-повідомлення. Сервіс працює.', idempotency_key: 'test-key' } } }; return { data: null }; } }, config: { enabled: true, stagingTestEnabled: true, primary: 'turbosms', fallback: 'mobizon', turboEnabled: true, mobizonEnabled: false, turboToken: 't', estimatedSegmentCost: 0 }, providers: { turbosms: { sendPaymentLink: async () => ({ accepted: true, providerMessageId: 'm-test', status: 'ACCEPTED' }) } } });
  const result = await service.createStagingTestSms({ propertyId: 'hotel-a', phone: '0501234567', callId: 'call-1', consent: true });
  assert.deepEqual(result, { ok: true, status: 'ACCEPTED', notification_id: 'n-test' });
  assert.equal(calls[0].name, 'sms_prepare_staging_test'); assert.equal(calls[0].args.p_phone, '+380501234567');
  assert.equal(calls.some(call => call.name === 'sms_finish_outbox'), true);
});

// Reliability regressions: these use a fake provider and Supabase RPC. No live SMS.
test('GSM-7 extension symbols cost two septets without forcing UCS-2', () => {
  assert.deepEqual(smsSegments('^{}\\[~]|€'), { encoding: 'gsm7', segments: 1 });
  assert.deepEqual(smsSegments('€'.repeat(80)), { encoding: 'gsm7', segments: 1 });
  assert.deepEqual(smsSegments('€'.repeat(81)), { encoding: 'gsm7', segments: 2 });
  assert.deepEqual(smsSegments('A'.repeat(159) + '^'), { encoding: 'gsm7', segments: 2 });
  assert.deepEqual(smsSegments('Вітаємо'), { encoding: 'ucs2', segments: 1 });
});

test('accepted provider submission with failed finish RPC reports UNKNOWN, never retries', async () => {
  let attempts = 0;
  const errors = [];
  const service = new SmsNotificationService({
    supabase: { rpc: async (method) => {
      if (method === 'sms_finish_outbox') return { error: new Error('database temporarily unavailable') };
      throw new Error('unexpected RPC');
    } },
    logger: { error: message => errors.push(message) },
    config: { enabled: true, primary: 'turbosms', fallback: 'mobizon', turboEnabled: true, mobizonEnabled: true, turboToken: 't', mobizonKey: 'm', estimatedSegmentCost: 0 },
    providers: {
      turbosms: { sendPaymentLink: async () => { attempts++; return { accepted: true, definitive: true, providerMessageId: 'receipt-1' }; } },
      mobizon: { sendPaymentLink: async () => { throw new Error('must not use fallback'); } },
    },
  });
  const result = await service.processClaimed({ id: 'sms-1', phone: '+380501234567', text: 'x', idempotency_key: 'unique' });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.reason, 'persistence_unconfirmed');
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes('database temporarily unavailable'));
});

test('transport success followed by an exception writing acknowledgement never reports acceptance', async () => {
  let calls = 0;
  const service = new SmsNotificationService({
    supabase: { rpc: async () => { throw new Error('RPC transport down'); } },
    config: { enabled: true, primary: 'turbosms', turboEnabled: true, turboToken: 't', estimatedSegmentCost: 0 },
    providers: { turbosms: { sendPaymentLink: async () => { calls++; return { accepted: true, definitive: true, providerMessageId: 'm1' }; } } },
    logger: { error: () => {} },
  });
  const result = await service.processClaimed({ id: 'n1', phone: '+380501234567', text: 'x', idempotency_key: 'same' });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(calls, 1);
});

test('missing provider acknowledgement is ambiguous and must not trigger fallback', async () => {
  let fallbackCalls = 0;
  const last = [];
  const service = new SmsNotificationService({
    supabase: { rpc: async (method,args) => { last.push({method,args}); return {data:null}; } },
    config: { enabled: true, primary: 'turbosms', fallback: 'mobizon', turboEnabled: true, mobizonEnabled: true, turboToken: 't', mobizonKey: 'm', estimatedSegmentCost: 0 },
    providers: {
      turbosms: { sendPaymentLink: async () => ({ accepted: false, definitive: false, status: 'MAYBE_ACCEPTED' }) },
      mobizon: { sendPaymentLink: async () => { fallbackCalls++; return { accepted: true }; } },
    },
  });
  const result = await service.processClaimed({ id:'n1', phone:'+380501234567', text:'x', idempotency_key:'k' });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(fallbackCalls, 0);
  assert.equal(last[0].args.p_status, 'UNKNOWN');
});

test('SMS outbox SQL never reclaims already-attempted expired PROCESSING jobs', () => {
  const { readFileSync } = require('node:fs');
  const sql = readFileSync(require('node:path').join(__dirname,'../sms-migration.sql'),'utf8');
  const claim = sql.split('create or replace function public.sms_claim_outbox()')[1].split('end $$;')[0];
  assert.match(claim, /status='UNKNOWN'/);
  assert.match(claim, /where status='PROCESSING' and lease_until<now\(\)/);
  assert.match(claim, /where status='QUEUED' and attempts=0/);
  assert.doesNotMatch(claim, /\(status='QUEUED' or \(status='PROCESSING'/);
});

test('SQL retains out-of-order delivery receipt and reconciles when send is recorded', () => {
  const { readFileSync } = require('node:fs');
  const sql = readFileSync(require('node:path').join(__dirname,'../sms-migration.sql'),'utf8');
  assert.match(sql, /add column if not exists provider_message_id text/);
  assert.match(sql, /insert into sms_delivery_events\(provider,event_id,provider_message_id,status,payload\)/);
  const finish = sql.split('create or replace function public.sms_finish_outbox(')[1].split('end $$;')[0];
  assert.match(finish, /update sms_delivery_events set notification_id=p_id/);
  assert.match(finish, /perform sms_apply_delivery_status\(p_id,v_receipt\)/);
  assert.match(sql, /when status='DELIVERED' then 'DELIVERED'/);
  assert.match(sql, /sms_finish_requires_processing_row/);
  assert.match(sql, /grant execute on function public.sms_finish_outbox\(uuid,text,text,text,text,integer,numeric\) to service_role/);
});

test('a second voice tool call does not send SMS again or turn UNKNOWN into success', async () => {
  let providerCalls = 0;
  let lookupCalls = 0;
  const service = new SmsNotificationService({
    supabase: { rpc: async (method) => {
      if (method === 'sms_prepare_staging_test') {
        lookupCalls++;
        return lookupCalls === 1
          ? { data: { ok: true, notification_id: 'n1', status: 'PROCESSING', job: { id: 'n1', phone: '+380501234567', text: 'test', idempotency_key: 'k' } } }
          : { data: { ok: true, notification_id: 'n1', status: 'ACCEPTED', idempotent: true } };
      }
      return { data: null };
    } },
    config: { enabled: true, stagingTestEnabled: true, primary: 'turbosms', turboEnabled: true, turboToken: 't', estimatedSegmentCost: 0 },
    providers: { turbosms: { sendPaymentLink: async () => { providerCalls++; return { accepted: true, providerMessageId: 'm1', definitive: true }; } } },
  });
  const params = { propertyId: 'hotel-a', callId: 'call1', phone: '+380501234567', consent: true };
  assert.equal((await service.createStagingTestSms(params)).status, 'ACCEPTED');
  assert.deepEqual(await service.createStagingTestSms(params), { ok: true, status: 'ACCEPTED', idempotent: true });
  assert.equal(providerCalls, 1);
});

test('an idempotent but UNKNOWN first attempt never falsely reports that a duplicate SMS was sent', async () => {
  const service = new SmsNotificationService({
    supabase: { rpc: async () => ({data: { ok: true, notification_id: 'n1', status: 'UNKNOWN', idempotent: true }}) },
    config: {enabled: true, stagingTestEnabled: true},
    providers: { turbosms: { sendPaymentLink: async () => { throw new Error('must not resend'); } } },
  });
  const result = await service.createStagingTestSms({propertyId:'hotel-a',callId:'call1',phone:'0501234567',consent:true});
  assert.deepEqual(result, {ok:false,status:'UNKNOWN',idempotent:true});
});