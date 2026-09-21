const test = require('node:test');
const assert = require('node:assert/strict');
const { downloadTelegramFile, parseTelegramUpdate } = require('../telegram');

test('parses a Telegram voice message without mistaking it for text', () => {
  const parsed = parseTelegramUpdate({
    message: { chat: { id: 42 }, from: { first_name: 'Олена' }, voice: { file_id: 'voice-file', file_size: 1234 } },
  });
  assert.deepEqual(parsed, {
    chatId: 42,
    text: null,
    voice: { fileId: 'voice-file', fileSize: 1234, mediaType: 'audio/ogg' },
    fromName: 'Олена',
  });
});

test('keeps text messages backwards compatible', () => {
  assert.equal(parseTelegramUpdate({ message: { chat: { id: 42 }, text: 'Привіт' } }).text, 'Привіт');
});

test('downloads a Telegram voice through the documented metadata flow', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('getFile')) return { ok: true, json: async () => ({ result: { file_path: 'voice/file.oga' } }) };
    return { ok: true, arrayBuffer: async () => Buffer.from('voice-bytes') };
  };
  const bytes = await downloadTelegramFile('bot-token', 'file-id', fetchImpl);
  assert.deepEqual(bytes, Buffer.from('voice-bytes'));
  assert.match(requests[0].url, /botbot-token\/getFile$/);
  assert.match(requests[1].url, /file\/botbot-token\/voice\/file\.oga$/);
});
