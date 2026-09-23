const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  TRANSCRIPTION_TIMEOUT_MS,
  TranscriptionError,
  normalizeText,
  transcribeAudio,
} = require('../transcription');

test('normalizes usable transcription text', () => {
  assert.equal(normalizeText('  Доброго\n\n дня,   є номер?  '), 'Доброго дня, є номер?');
});

test('never calls a provider when transcription is not configured', async () => {
  let calls = 0;
  await assert.rejects(
    transcribeAudio({ audio: Buffer.from('voice'), mediaType: 'audio/ogg', fetchImpl: async () => { calls++; } }),
    error => error instanceof TranscriptionError && error.code === 'TRANSCRIPTION_NOT_CONFIGURED'
  );
  assert.equal(calls, 0);
});

test('sends valid audio to an OpenAI-compatible endpoint without exposing it in the result', async () => {
  let request;
  const text = await transcribeAudio({
    audio: Buffer.from('voice-bytes'),
    mediaType: 'audio/ogg',
    filename: 'guest voice.ogg',
    language: 'uk',
    endpoint: 'https://transcriber.example/v1/audio/transcriptions',
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ text: '  Вітаю, потрібен номер. ' }) };
    },
  });

  assert.equal(text, 'Вітаю, потрібен номер.');
  assert.equal(request.url, 'https://transcriber.example/v1/audio/transcriptions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(request.options.body.get('model'), 'test-model');
  assert.equal(request.options.body.get('language'), 'uk');
  assert.equal(request.options.body.get('file').type, 'audio/ogg');
});

test('rejects unsupported and oversize uploads before contacting the provider', async () => {
  const configured = { apiKey: 'test-key', fetchImpl: async () => { throw new Error('must not call'); } };
  await assert.rejects(
    transcribeAudio({ ...configured, audio: Buffer.from('x'), mediaType: 'text/plain' }),
    error => error.code === 'UNSUPPORTED_MEDIA_TYPE'
  );
  await assert.rejects(
    transcribeAudio({ ...configured, audio: Buffer.alloc(MAX_AUDIO_BYTES + 1), mediaType: 'audio/ogg' }),
    error => error.code === 'AUDIO_TOO_LARGE'
  );
  await assert.rejects(
    transcribeAudio({ ...configured, audio: Buffer.from('x'), mediaType: 'audio/ogg', durationSeconds: MAX_AUDIO_DURATION_SECONDS + 1 }),
    error => error.code === 'AUDIO_TOO_LONG'
  );
});

test('converts provider failures into safe customer-facing errors', async () => {
  await assert.rejects(
    transcribeAudio({
      audio: Buffer.from('voice'), mediaType: 'audio/ogg', apiKey: 'test-key',
      fetchImpl: async () => ({ ok: false, json: async () => ({ error: { message: 'secret provider detail' } }) }),
    }),
    error => error.code === 'TRANSCRIPTION_PROVIDER_ERROR' && !error.message.includes('secret')
  );
});

test('aborts a stalled provider request instead of leaving the channel webhook waiting forever', async () => {
  let receivedSignal;
  await assert.rejects(
    transcribeAudio({
      audio: Buffer.from('voice'),
      mediaType: 'audio/ogg',
      apiKey: 'test-key',
      timeoutMs: 5,
      fetchImpl: async (_url, options) => new Promise((_, reject) => {
        receivedSignal = options.signal;
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    }),
    error => error instanceof TranscriptionError && error.code === 'TRANSCRIPTION_TIMEOUT'
  );
  assert.ok(receivedSignal?.aborted);
  assert.equal(TRANSCRIPTION_TIMEOUT_MS, 45 * 1000);
});
