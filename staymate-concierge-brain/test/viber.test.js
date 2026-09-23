const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  MAX_VIBER_TEXT_LENGTH,
  parseViberUpdate,
  sendViberMessage,
  setViberWebhook,
  verifyViberSignature,
} = require('../viber');

test('accepts only a valid Viber HMAC signature for the raw webhook body', () => {
  const body = JSON.stringify({ event: 'message', sender: { id: 'guest' } });
  const token = 'viber-test-token';
  const signature = crypto.createHmac('sha256', token).update(body, 'utf8').digest('hex');

  assert.equal(verifyViberSignature(body, signature, token), true);
  assert.equal(verifyViberSignature(body + ' ', signature, token), false);
  assert.equal(verifyViberSignature(body, signature, 'other-token'), false);
  assert.equal(verifyViberSignature(body, '', token), false);
});

test('normalizes only usable Viber text messages', () => {
  assert.deepEqual(
    parseViberUpdate({
      event: 'message',
      sender: { id: 'guest-1', name: 'Guest' },
      message: { type: 'text', text: 'Hello' },
    }),
    { chatId: 'guest-1', text: 'Hello', fromName: 'Guest' }
  );
  assert.equal(parseViberUpdate({ event: 'webhook' }), null);
  assert.equal(parseViberUpdate({ event: 'message', sender: { id: 'guest-1' }, message: { type: 'picture' } }), null);
});

test('sends a bounded Viber reply with the bot token in the API header', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { json: async () => ({ status: 0, message_token: 123 }) };
  };
  try {
    const result = await sendViberMessage('bot-token', 'guest-1', 'x'.repeat(MAX_VIBER_TEXT_LENGTH + 1), 'Hotel');
    assert.equal(result.status, 0);
    assert.equal(request.url, 'https://chatapi.viber.com/pa/send_message');
    assert.equal(request.options.headers['X-Viber-Auth-Token'], 'bot-token');
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.receiver, 'guest-1');
    assert.equal(payload.text.length, MAX_VIBER_TEXT_LENGTH);
    assert.equal(payload.sender.name, 'Hotel');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fails safely when Viber rejects an outgoing message or webhook response is malformed', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 401, json: async () => ({ status: 6, status_message: 'invalidAuthToken' }) });
  try {
    await assert.rejects(() => sendViberMessage('bad', 'guest', 'hello'), /Viber sendMessage failed: invalidAuthToken/);
  } finally {
    global.fetch = originalFetch;
  }

  global.fetch = async () => ({ status: 502, json: async () => { throw new Error('not json'); } });
  try {
    await assert.rejects(() => setViberWebhook('token', 'https://example.com/hook'), /Viber setWebhook failed: HTTP 502/);
  } finally {
    global.fetch = originalFetch;
  }
});
