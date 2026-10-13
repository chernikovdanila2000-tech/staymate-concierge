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
