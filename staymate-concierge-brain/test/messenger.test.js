const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  verifyMessengerSignature,
  parseMessengerEvents,
  sendMessengerMessage,
} = require('../messenger');

test('accepts an authentic Messenger webhook signature and rejects altered input', () => {
  const body = JSON.stringify({ object: 'page', entry: [] });
  const secret = 'test-app-secret';
  const signature =
    'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  assert.equal(verifyMessengerSignature(body, signature, secret), true);
  assert.equal(verifyMessengerSignature(body + 'x', signature, secret), false);
  assert.equal(verifyMessengerSignature(body, 'sha1=bad', secret), false);
  assert.equal(verifyMessengerSignature(body, signature, ''), false);
});

test('parses text and postback events per Page while ignoring echoes and unsupported events', () => {
  const events = parseMessengerEvents({
    object: 'page',
    entry: [
      {
        id: 'page-a',
        messaging: [
          { sender: { id: 'guest-a' }, message: { text: '  Hello  ' } },
          { sender: { id: 'guest-a' }, message: { is_echo: true, text: 'sent reply' } },
          { sender: { id: 'guest-a' }, postback: { title: 'Book now', payload: 'BOOK' } },
          { sender: { id: 'guest-a' }, message: { attachments: [{ type: 'image' }] } },
        ],
      },
      {
        id: 'page-b',
        messaging: [{ sender: { id: 'guest-b' }, message: { text: 'Need a room' } }],
      },
    ],
  });

  assert.deepEqual(events, [
    { pageId: 'page-a', senderId: 'guest-a', text: 'Hello' },
    { pageId: 'page-a', senderId: 'guest-a', text: 'Book now' },
    { pageId: 'page-b', senderId: 'guest-b', text: 'Need a room' },
  ]);

  assert.deepEqual(
    parseMessengerEvents({ object: 'page', entry: [{ id: 'page-b', messaging: [] }] }, 'page-a'),
    []
  );
});

test('sends a bounded response to the Messenger Graph API', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ recipient_id: 'guest-a', message_id: 'mid.1' }) };
  };

  try {
    const result = await sendMessengerMessage('page-token', 'guest-a', 'x'.repeat(2100), 'v24.0');
    assert.equal(result.message_id, 'mid.1');
    assert.equal(request.url, 'https://graph.facebook.com/v24.0/me/messages');
    assert.equal(request.options.headers.Authorization, 'Bearer page-token');
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.recipient.id, 'guest-a');
    assert.equal(payload.messaging_type, 'RESPONSE');
    assert.equal(payload.message.text.length, 2000);
  } finally {
    global.fetch = originalFetch;
  }
});

test('surfaces a Graph API failure without treating it as a successful reply', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, text: async () => 'invalid recipient' });

  try {
    await assert.rejects(
      () => sendMessengerMessage('page-token', 'guest-a', 'hello'),
      /Messenger send failed: 400 invalid recipient/
    );
  } finally {
    global.fetch = originalFetch;
  }
});
