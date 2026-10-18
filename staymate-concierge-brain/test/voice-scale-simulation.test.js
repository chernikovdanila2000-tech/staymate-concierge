'use strict';

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_KEY ||= 'test-key';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { VoiceCallService, voiceConfig } = require('../voice-calls');

function fakeSocket() {
  const socket = new EventEmitter();
  socket.OPEN = 1; socket.readyState = 1; socket.send = () => {}; socket.close = () => { socket.readyState = 3; };
  return socket;
}

test('100 simultaneous synthetic SIP arrivals retain an isolated tenant and call context each', async () => {
  const accepted = []; const completed = []; const sockets = new Map();
  const client = {
    unwrapWebhook: async raw => JSON.parse(raw),
    acceptCall: async (callId, session) => accepted.push({ callId, session }),
    openMonitor: (callId, handlers) => { const socket = fakeSocket(); sockets.set(callId, socket); handlers.onOpen(); return socket; },
    hangupCall: async () => {},
  };
  const repo = {
    begin: async input => ({ ok: true, property_id: `hotel-${input.p_to_number.slice(-3)}`, admin_transfer_uri: null }),
    property: async propertyId => ({ property_id: propertyId, hotel_name: `Hotel ${propertyId}` }),
    finish: async input => { completed.push(input); },
  };
  const service = new VoiceCallService({
    repository: repo, realtimeClient: client,
    config: { ...voiceConfig({ VOICE_ENABLED: 'true', VOICE_OPENAI_API_KEY: 'x', VOICE_OPENAI_WEBHOOK_SECRET: 'y', VOICE_TRUST_SIP_CALLER_ID: 'true' }), enabled: true, apiKey: 'x', webhookSecret: 'y' },
    getHotelInfoImpl: async propertyId => ({ propertyId }), buildPromptImpl: ({ propertyName }) => `PROMPT:${propertyName}`,
    toolsFactory: () => ({}), setTimeoutImpl: () => ({}), clearTimeoutImpl: () => {}, logger: { info() {}, warn() {}, error() {} },
  });
  const events = Array.from({ length: 100 }, (_, i) => ({ type: 'realtime.call.incoming', data: { call_id: `load-${i}`, sip_headers: [{ name: 'To', value: `sip:+38044000${String(i).padStart(3, '0')}@carrier` }, { name: 'From', value: `sip:+38050${String(i).padStart(7, '0')}@carrier` }] } }));
  const results = await Promise.all(events.map(event => service.handleWebhook(JSON.stringify(event), {})));
  assert.equal(results.filter(result => result.status === 200).length, 100);
  assert.equal(service.calls.size, 100);
  assert.equal(accepted.length, 100);
  for (const { callId, session } of accepted) {
    const suffix = callId.slice(5).padStart(3, '0');
    assert.match(session.instructions, new RegExp(`Hotel hotel-${suffix}`));
    assert.equal(service.calls.get(callId).callerPhone, `+38050${suffix.padStart(7, '0')}`);
  }
  await Promise.all([...service.calls.values()].map(state => service.finishCall(state, 'completed', 'synthetic_load_test')));
  assert.equal(service.calls.size, 0);
  assert.equal(completed.length, 100);
});
