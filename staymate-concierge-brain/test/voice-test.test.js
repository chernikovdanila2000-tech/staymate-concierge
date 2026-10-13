'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceTestService, hasVoiceTestAccess, voiceTestConfig } = require('../voice-test');

const header = token => ({ authorization: `Basic ${Buffer.from(`stayai-test:${token}`).toString('base64')}` });

test('voice test stays disabled until explicitly configured and requires Basic access', () => {
  const config = voiceTestConfig({ PROPERTY_ID: 'hotel-a', TRANSCRIPTION_API_KEY: 'key' });
  assert.equal(config.enabled, false);
  assert.equal(hasVoiceTestAccess(header('one'), 'one'), true);
  assert.equal(hasVoiceTestAccess(header('wrong'), 'one'), false);
  assert.equal(hasVoiceTestAccess({}, 'one'), false);
});

test('voice test creates a tenant-fixed realtime WebRTC session without exposing the API key', async () => {
  let request;
  const service = new VoiceTestService({
    config: voiceTestConfig({ VOICE_TEST_ENABLED: 'true', VOICE_TEST_ACCESS_TOKEN: 'pass', VOICE_TEST_PROPERTY_ID: 'hotel-a', TRANSCRIPTION_API_KEY: 'server-key', VOICE_MODEL: 'gpt-realtime-2.1-mini' }),
    supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { property_id: 'hotel-a', hotel_name: 'Hotel A' }, error: null }) }) }) }) },
    getHotelInfoImpl: async id => ({ property_id: id, parking: 'yes' }),
    buildPromptImpl: ({ propertyName, hotelInfo }) => `${propertyName} ${hotelInfo.parking}`,
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, text: async () => 'v=0' }; },
  });
  const answer = await service.createSessionAnswer('v=0\\no=- 1 1 IN IP4 127.0.0.1');
  assert.equal(answer, 'v=0');
  assert.equal(request.url, 'https://api.openai.com/v1/realtime/calls');
  assert.equal(request.options.headers.Authorization, 'Bearer server-key');
  const session = JSON.parse(request.options.body.get('session'));
  assert.equal(session.model, 'gpt-realtime-2.1-mini');
  assert.equal(session.audio.input.turn_detection.interrupt_response, true);
  assert.match(session.instructions, /Hotel A yes/);
});
