const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  downloadInstagramMedia,
  parseInstagramEvents,
  prepareInstagramIncomingText,
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
    { accountId: 'ig-hotel-a', senderId: 'guest-a', text: 'Вітаю', audio: null },
    { accountId: 'ig-hotel-b', senderId: 'guest-b', text: 'Hello', audio: null },
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
    { accountId: 'ig-hotel-a', senderId: 'guest-a', text: 'Need a room', audio: null },
  ]);
});

test('parses a supported Instagram audio attachment as an inbound voice event', () => {
  const events = parseInstagramEvents({
    object: 'instagram',
    entry: [{
      id: 'ig-hotel-a',
      messaging: [{
        sender: { id: 'guest-a' },
        message: {
          attachments: [{
            type: 'audio',
            payload: {
              url: 'https://cdn.instagram.example/temporary-audio',
              mime_type: 'audio/ogg; codecs=opus',
              file_size: 1234,
              duration: 12,
              filename: 'voice.ogg',
            },
          }],
        },
      }],
    }],
  });

  assert.deepEqual(events, [{
    accountId: 'ig-hotel-a',
    senderId: 'guest-a',
    text: null,
    audio: {
      url: 'https://cdn.instagram.example/temporary-audio',
      mediaId: '',
      mediaType: 'audio/ogg',
      fileSize: 1234,
      durationSeconds: 12,
      filename: 'voice.ogg',
    },
  }]);
});

test('ignores an unsupported Instagram attachment without treating it as guest text', () => {
  const events = parseInstagramEvents({
    entry: [{
      id: 'ig-hotel-a',
      messaging: [{ sender: { id: 'guest-a' }, message: { attachments: [{ type: 'image', payload: { url: 'https://cdn.example/photo' } }] } }],
    }],
  });
  assert.deepEqual(events, []);
});

test('downloads temporary Instagram audio with the access token and keeps it in memory', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/ogg', 'content-length': '3' },
    });
  };

  const media = await downloadInstagramMedia('access-token', {
    url: 'https://cdn.instagram.example/audio', mediaType: 'audio/ogg', filename: 'voice.ogg',
  }, 'v24.0', fetchImpl);

  assert.deepEqual([...media.audio], [1, 2, 3]);
  assert.equal(media.mediaType, 'audio/ogg');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer access-token');
  assert.equal(requests[0].options.redirect, 'error');
});

test('prefers the official Graph media URL over an attachment wrapper when a media id exists', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('/media-123?fields=')) {
      return new Response(JSON.stringify({
        url: 'https://cdn.instagram.example/raw-audio',
        mime_type: 'audio/ogg',
        file_size: 4,
        duration: 2,
      }), { status: 200 });
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'audio/ogg', 'content-length': '4' },
    });
  };

  const media = await downloadInstagramMedia('access-token', {
    mediaId: 'media-123',
    url: 'https://cdn.instagram.example/attachment-wrapper',
    mediaType: 'audio/ogg',
  }, 'v24.0', fetchImpl);

  assert.match(requests[0].url, /graph\.facebook\.com\/v24\.0\/media-123\?fields=/);
  assert.equal(requests[1].url, 'https://cdn.instagram.example/raw-audio');
  assert.equal(media.durationSeconds, 2);
  assert.deepEqual([...media.audio], [1, 2, 3, 4]);
});

test('uses the shared transcription service result as ordinary incoming text for the AI pipeline', async () => {
  const text = await prepareInstagramIncomingText({
    event: { audio: { url: 'https://cdn.instagram.example/audio', durationSeconds: 4 } },
    accessToken: 'access-token',
    downloadMedia: async () => ({
      audio: Buffer.from('voice'), mediaType: 'audio/ogg', filename: 'voice.ogg', durationSeconds: 4,
    }),
    transcribe: async ({ audio, mediaType }) => {
      assert.deepEqual(audio, Buffer.from('voice'));
      assert.equal(mediaType, 'audio/ogg');
      return 'Потрібен номер на двох';
    },
  });

  assert.equal(text, 'Потрібен номер на двох');
});

test('surfaces media-download and transcription failures for the customer-safe webhook fallback', async () => {
  const event = { audio: { url: 'https://cdn.instagram.example/audio', durationSeconds: 4 } };
  await assert.rejects(
    () => prepareInstagramIncomingText({ event, accessToken: 'token', downloadMedia: async () => { throw new Error('download failed'); } }),
    /download failed/
  );
  await assert.rejects(
    () => prepareInstagramIncomingText({
      event,
      accessToken: 'token',
      downloadMedia: async () => ({ audio: Buffer.from('voice'), mediaType: 'audio/ogg', filename: 'voice.ogg' }),
      transcribe: async () => { throw new Error('transcription failed'); },
    }),
    /transcription failed/
  );
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
