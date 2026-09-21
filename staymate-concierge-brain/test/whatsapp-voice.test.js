const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VOICE_PROCESSING_FALLBACK,
  parseWhatsAppEvents,
  downloadWhatsAppMedia,
} = require('../whatsapp');

test('keeps a customer-safe fallback for WhatsApp voice processing failures', () => {
  assert.match(VOICE_PROCESSING_FALLBACK, /надішліть.*ще раз|напишіть.*текстом/i);
  assert.doesNotMatch(VOICE_PROCESSING_FALLBACK, /token|openai|meta|error/i);
});

test('parses an inbound WhatsApp voice message without treating it as text', () => {
  const events = parseWhatsAppEvents({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'phone-1' },
      messages: [{ id: 'wamid-1', from: 'guest-1', type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus' } }],
    } }] }],
  });

  assert.deepEqual(events, [{
    phoneNumberId: 'phone-1', senderId: 'guest-1', text: null,
    audio: { mediaId: 'media-1', mediaType: 'audio/ogg' }, messageId: 'wamid-1',
  }]);
});

test('downloads WhatsApp audio through the authenticated two-step media API', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/voice', mime_type: 'audio/ogg', file_size: 3 }), { status: 200 });
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/ogg' } });
  };

  const result = await downloadWhatsAppMedia('token', 'media-1', 'phone-1', 'v24.0', fetchImpl);
  assert.deepEqual([...result.audio], [1, 2, 3]);
  assert.equal(result.mediaType, 'audio/ogg');
  assert.equal(result.fileSize, 3);
  assert.match(requests[0].url, /media-1\?phone_number_id=phone-1$/);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer token');
  assert.equal(requests[1].options.redirect, 'error');
});

test('refuses a non-HTTPS media URL before downloading it', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ url: 'http://example.test/voice' }), { status: 200 });
  await assert.rejects(
    () => downloadWhatsAppMedia('token', 'media-1', 'phone-1', 'v24.0', fetchImpl),
    /must use HTTPS/
  );
});
