'use strict';

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_KEY ||= 'test-key';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { VoiceCallService, normalizePhoneNumber, safeTransportCode, toRealtimeTools, voiceConfig, voiceConversationRules } = require('../voice-calls');

test('normalizes SIP destination without retaining caller details', () => {
  assert.equal(normalizePhoneNumber('sip:+380 (44) 123-45-67@example.com'), '+380441234567');
  assert.equal(normalizePhoneNumber('tel:380441234567'), '+380441234567');
  assert.equal(normalizePhoneNumber('sip:proj_AJV3lMNB4yT4ITo42ScEZMmC@sip.api.openai.com'), null);
  assert.equal(normalizePhoneNumber(''), null);
});

test('uses an economical configurable realtime model and ten-minute pilot default', () => {
  const config = voiceConfig({ VOICE_ENABLED: 'true' });
  assert.equal(config.model, 'gpt-realtime-2.1-mini');
  assert.equal(config.maxDurationSeconds, 600);
  assert.equal(config.vad.interrupt_response, true);
  assert.equal(config.vad.threshold, 0.35);
  assert.equal(config.vad.silence_duration_ms, 350);
  assert.equal(config.voiceSpeed, 1.05);
  assert.equal(config.voice, 'coral');
  assert.equal(voiceConfig({ VOICE_MODEL: 'chosen-model', VOICE_CALL_MAX_DURATION_SECONDS: '42' }).model, 'chosen-model');
  assert.equal(voiceConfig({ VOICE_CALL_MAX_DURATION_SECONDS: '42' }).maxDurationSeconds, 42);
  assert.equal(voiceConfig({ TRANSCRIPTION_API_KEY: 'server-only-key' }).apiKey, 'server-only-key');
  assert.equal(voiceConfig({ VOICE_OPENAI_API_KEY: 'voice-key', TRANSCRIPTION_API_KEY: 'server-only-key' }).apiKey, 'voice-key');
  assert.equal(voiceConfig({ VOICE_DEFAULT_PHONE_NUMBER: '+380441111111' }).defaultPhoneNumber, '+380441111111');
});

test('adds phone-only natural language and no-internal-process rules', () => {
  const rules = voiceConversationRules('Hotel A');
  assert.match(rules, /complete request in Russian/i);
  assert.match(rules, /Сколько стоит номер/);
  assert.match(rules, /NEVER mention a catalog/i);
  assert.match(rules, /stop immediately and listen/i);
});

test('classifies a failed OpenAI request without publishing its message', () => {
  assert.equal(safeTransportCode({ cause: { code: 'ENOTFOUND' } }), 'dns_failed');
  assert.equal(safeTransportCode({ status: 401 }), 'http_401');
  assert.equal(safeTransportCode(new Error('private details')), 'network_request_failed');
});

test('uses an explicitly configured carrier number when SIP To contains only the OpenAI project URI', async () => {
  let suppliedTo;
  const service = new VoiceCallService({
    repository: { begin: async input => { suppliedTo = input.p_to_number; return { ok: false, code: 'NO_MAPPING' }; } },
    realtimeClient: { unwrapWebhook: async () => ({ type: 'realtime.call.incoming', data: { call_id: 'call-project-uri', sip_headers: [{ name: 'To', value: 'sip:proj_AJV3lMNB4yT4ITo42ScEZMmC@sip.api.openai.com' }] } }), hangupCall: async () => {}, acceptCall: async () => {} },
    config: { ...voiceConfig({ VOICE_ENABLED: 'true', VOICE_OPENAI_API_KEY: 'x', VOICE_OPENAI_WEBHOOK_SECRET: 'y', VOICE_DEFAULT_PHONE_NUMBER: '+380443002819' }), enabled: true, apiKey: 'x', webhookSecret: 'y' },
    logger: { warn() {}, error() {} },
  });
  await service.handleWebhook('{}', {});
  assert.equal(suppliedTo, '+380443002819');
});

test('converts the existing tenant-safe tools to Realtime function tools', () => {
  assert.deepEqual(toRealtimeTools([{ name: 'check_availability', description: 'check', input_schema: { type: 'object' } }]), [{ type: 'function', name: 'check_availability', description: 'check', parameters: { type: 'object' } }]);
});

test('accepts a mapped call with VAD barge-in and only its mapped tenant', async () => {
  const socket = new EventEmitter(); socket.OPEN = 1; socket.readyState = 1; socket.send = () => {}; socket.close = () => {};
  const accepted = [];
  const client = {
    unwrapWebhook: async () => ({ type: 'realtime.call.incoming', data: { call_id: 'call-1', sip_headers: [{ name: 'To', value: 'sip:+380441111111@voice' }, { name: 'From', value: 'sip:+380991234567@provider' }] } }),
    acceptCall: async (id, session) => accepted.push({ id, session }), openMonitor: () => socket, hangupCall: async () => {}, referCall: async () => {},
  };
  const repo = { begin: async () => ({ ok: true, property_id: 'hotel-a', admin_transfer_uri: 'tel:+380441234567' }), property: async () => ({ property_id: 'hotel-a', hotel_name: 'Hotel A' }), finish: async () => {} };
  const service = new VoiceCallService({ repository: repo, realtimeClient: client, config: { ...voiceConfig({ VOICE_ENABLED: 'true', VOICE_OPENAI_API_KEY: 'x', VOICE_OPENAI_WEBHOOK_SECRET: 'y' }), enabled: true, apiKey: 'x', webhookSecret: 'y' }, getHotelInfoImpl: async propertyId => ({ propertyId, address: 'A street' }), buildPromptImpl: ({ propertyName }) => `ONLY ${propertyName}`, toolsFactory: () => ({ escalate_to_human: async () => ({ ok: true }) }), setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {} });
  const result = await service.handleWebhook('{}', {});
  assert.equal(result.status, 200);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].session.audio.input.turn_detection.interrupt_response, true);
  assert.equal(accepted[0].session.audio.output.speed, 1.05);
  assert.equal(service.health().diagnostic.stage, 'accept_succeeded');
  assert.match(accepted[0].session.instructions, /ONLY Hotel A/);
  assert.doesNotMatch(accepted[0].session.instructions, /Hotel B/);
  service.onEvent(service.calls.get('call-1'), { type: 'input_audio_buffer.speech_started' });
  assert.equal(service.calls.get('call-1').bargeIns, 1);
  assert.equal(service.health().diagnostic.stage, 'input_audio_detected');
});

test('starts an audible greeting only after the sideband is connected', async () => {
  const socket = new EventEmitter(); socket.OPEN = 1; socket.readyState = 1; const sent = []; socket.send = payload => sent.push(JSON.parse(payload)); socket.close = () => {};
  let sidebandOptions;
  const client = {
    unwrapWebhook: async () => ({ type: 'realtime.call.incoming', data: { call_id: 'call-greeting', sip_headers: [{ name: 'To', value: 'sip:+380441111111@voice' }] } }),
    acceptCall: async () => {}, openMonitor: (_, options) => { sidebandOptions = options; return socket; }, hangupCall: async () => {}, referCall: async () => {},
  };
  const repo = { begin: async () => ({ ok: true, property_id: 'hotel-a', admin_transfer_uri: null }), property: async () => ({ property_id: 'hotel-a', hotel_name: 'Hotel A' }), finish: async () => {} };
  const service = new VoiceCallService({ repository: repo, realtimeClient: client, config: { ...voiceConfig({ VOICE_ENABLED: 'true', VOICE_OPENAI_API_KEY: 'x', VOICE_OPENAI_WEBHOOK_SECRET: 'y' }), enabled: true, apiKey: 'x', webhookSecret: 'y' }, getHotelInfoImpl: async () => ({}), buildPromptImpl: () => 'prompt', toolsFactory: () => ({}), setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {}, logger: { info() {}, warn() {}, error() {} } });
  await service.handleWebhook('{}', {});
  assert.equal(sent.length, 0);
  sidebandOptions.onOpen();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'response.create');
  assert.match(sent[0].response.instructions, /Hotel A/);
  assert.equal(service.health().diagnostic.stage, 'greeting_requested');
});

test('does not accept an unmapped or rate-limited call', async () => {
  let hungUp = 0; let accepted = 0;
  const service = new VoiceCallService({ repository: { begin: async () => ({ ok: false, code: 'HOTEL_DAILY_LIMIT' }) }, realtimeClient: { unwrapWebhook: async () => ({ type: 'realtime.call.incoming', data: { call_id: 'call-limit', sip_headers: [{ name: 'To', value: '+380441111111' }] } }), hangupCall: async () => { hungUp++; }, acceptCall: async () => { accepted++; } }, config: { ...voiceConfig({ VOICE_ENABLED: 'true', VOICE_OPENAI_API_KEY: 'x', VOICE_OPENAI_WEBHOOK_SECRET: 'y' }), enabled: true, apiKey: 'x', webhookSecret: 'y' }, logger: { warn() {}, error() {} } });
  const result = await service.handleWebhook('{}', {});
  assert.equal(result.status, 200); assert.equal(hungUp, 1); assert.equal(accepted, 0);
});

test('reports an OpenAI accept failure without exposing provider details', async () => {
  const client = { unwrapWebhook: async () => ({ type: 'realtime.call.incoming', data: { call_id: 'call-accept-failure', sip_headers: [{ name: 'To', value: '+380441111111' }] } }), acceptCall: async () => { throw new Error('OpenAI Realtime POST 400'); }, hangupCall: async () => {} };
  const repo = { begin: async () => ({ ok: true, property_id: 'hotel-a' }), property: async () => ({ property_id: 'hotel-a', hotel_name: 'Hotel A' }), finish: async () => {} };
  const service = new VoiceCallService({ repository: repo, realtimeClient: client, config: { ...voiceConfig({ VOICE_ENABLED: 'true', VOICE_OPENAI_API_KEY: 'x', VOICE_OPENAI_WEBHOOK_SECRET: 'y' }), enabled: true, apiKey: 'x', webhookSecret: 'y' }, getHotelInfoImpl: async () => ({}), buildPromptImpl: () => 'prompt', toolsFactory: () => ({}), logger: { warn() {}, error() {} } });
  await service.handleWebhook('{}', {});
  assert.equal(service.health().diagnostic.stage, 'accept_failed');
});

test('human transfer never uses a caller-provided destination', async () => {
  let destination; let escalated = 0;
  const service = new VoiceCallService({ realtimeClient: { referCall: async (_, uri) => { destination = uri; } }, repository: { finish: async () => {} }, config: voiceConfig(), toolsFactory: () => ({ escalate_to_human: async () => { escalated++; } }), clearTimeoutImpl: () => {} });
  const state = { callId: 'call-transfer', propertyId: 'hotel-a', adminTransferUri: 'tel:+380441111111', toolCalls: new Set() };
  const result = await service.transferToHuman(state, { reason: 'please call +1999', destination: 'tel:+1999' });
  assert.equal(result.transferred, true); assert.equal(destination, 'tel:+380441111111'); assert.equal(escalated, 1);
});
