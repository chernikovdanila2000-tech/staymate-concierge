const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  parseInstagramEvents,
  sendInstagramMessage,
  verifyInstagramSignature,
} = require('../instagram');

test('keeps the originating Instagram account on every inbound event', () => {
  const events = parseInstagramEvents({
    object: 'instagram',
    entry: [
      {
        id: 'ig-hotel-a',
        messaging: [{ sender: { id: 'guest-a' }, message: { text: 'Вітаю' } }],
      },
      {
        id: 'ig-hotel-b',
        messaging: [{ sender: { id: 'guest-b' }, message: { text: 'Hello' } }],
      },
    ],
  });

  assert.deepEqual(events, [
    { accountId: 'ig-hotel-a', senderId: 'guest-a', text: 'Вітаю' },
    { accountId: 'ig-hotel-b', senderId: 'guest-b', text: 'Hello' },
  ]);
});

test('ignores echoes, blank messages, and entries without an account id', () => {
  const events = parseInstagramEvents({
    entry: [
      {
        id: 'ig-hotel-a',
        messaging: [
          { sender: { id: 'guest-a' }, message: { is_echo: true, text: 'sent by bot' } },
          { sender: { id: 'guest-a' }, message: { text: '   ' } },
          { sender: { id: 'guest-a' }, postback: { title: 'Need a room' } },
        ],
      },
      { messaging: [{ sender: { id: 'guest-b' }, message: { text: 'must not route' } }] },
    ],
  });

  assert.deepEqual(events, [
    { accountId: 'ig-hotel-a', senderId: 'guest-a', text: 'Need a room' },
  ]);
});

test('accepts only a valid Meta SHA-256 signature', () => {
  const rawBody = '{"entry":[]}';
  const secret = 'app-secret';
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  assert.equal(verifyInstagramSignature(rawBody, signature, secret), true);
  assert.equal(verifyInstagramSignature(rawBody, 'sha256=wrong', secret), false);
  assert.equal(verifyInstagramSignature(rawBody, signature, ''), false);
});

test('sends a bounded text reply through the Meta Send API', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ recipient_id: 'guest-a', message_id: 'mid-1' }), { status: 200 });
  };

  const result = await sendInstagramMessage(
    'access-token',
    'ig-hotel-a',
    'guest-a',
    'x'.repeat(1005),
    'v24.0',
    fetchImpl
  );

  assert.deepEqual(result, { recipient_id: 'guest-a', message_id: 'mid-1' });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /graph\.facebook\.com\/v24\.0\/me\/messages$/);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer access-token');
  assert.equal(JSON.parse(requests[0].options.body).message.text.length, 1000);
});

test('does not copy a Meta error body into the thrown error', async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ error: { message: 'customer metadata must stay out of logs' } }),
    { status: 400 }
  );

  await assert.rejects(
    () => sendInstagramMessage('token', 'ig-account', 'guest', 'Hi', 'v24.0', fetchImpl),
    /Instagram send failed: 400$/
  );
});
