'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenAIRealtimeClient } = require('../openai-realtime');

function makeClient(requests) {
  return new OpenAIRealtimeClient({
    apiKey: 'test-key',
    webhookSecret: 'whsec_test',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 204, json: async () => ({}) };
    },
  });
}

test('Realtime SIP controls preserve the action path and encode only the call id', async () => {
  const requests = [];
  const client = makeClient(requests);
  const callId = 'call/with space';

  await client.acceptCall(callId, { type: 'realtime' });
  await client.referCall(callId, 'sip:admin@example.com');
  await client.rejectCall(callId);
  await client.hangupCall(callId);

  assert.deepEqual(requests.map(request => request.url), [
    'https://api.openai.com/v1/realtime/calls/call%2Fwith%20space/accept',
    'https://api.openai.com/v1/realtime/calls/call%2Fwith%20space/refer',
    'https://api.openai.com/v1/realtime/calls/call%2Fwith%20space/reject',
    'https://api.openai.com/v1/realtime/calls/call%2Fwith%20space/hangup',
  ]);
  assert.deepEqual(JSON.parse(requests[1].options.body), { target_uri: 'sip:admin@example.com' });
});

test('keeps an OpenAI error code for safe operational diagnostics', async () => {
  const client = new OpenAIRealtimeClient({
    apiKey: 'test-key', webhookSecret: 'whsec_test',
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 'unsupported_value' } }) }),
  });
  await assert.rejects(() => client.acceptCall('call-1', { type: 'realtime' }), error => error.status === 400 && error.providerCode === 'unsupported_value');
});

test('treats the documented empty 200 SIP accept response as success', async () => {
  const client = new OpenAIRealtimeClient({
    apiKey: 'test-key', webhookSecret: 'whsec_test',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }),
  });
  assert.equal(await client.acceptCall('call-1', { type: 'realtime' }), null);
});
