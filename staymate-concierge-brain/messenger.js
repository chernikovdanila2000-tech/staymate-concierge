const crypto = require('crypto');
const {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  TranscriptionError,
  transcribeAudio,
} = require('./transcription');

// A guest must never see silence when Meta's short-lived attachment URL or
// the transcription provider fails. This is deliberately provider-neutral
// and contains no internal diagnostics.
const VOICE_PROCESSING_FALLBACK =
  'Не вдалося розпізнати голосове повідомлення. Будь ласка, надішліть його ще раз або напишіть повідомлення текстом.';

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyMessengerSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  return safeEqual(signatureHeader, expected);
}

// expectedPageId, коли передано, звужує розбір до однієї сторінки (старий
// однотенантний режим). Без нього повертає події з УСІХ сторінок у payload,
// кожну з власним pageId — так виклик може роутити кожну подію на
// правильного готеля через resolveMessengerConnection(event.pageId),
// а не припускати, що весь payload належить одному й тому самому готелю.
function parseMessengerEvents(payload, expectedPageId) {
  if (!payload || payload.object !== 'page' || !Array.isArray(payload.entry)) return [];
  const events = [];
  for (const entry of payload.entry) {
    if (expectedPageId && String(entry.id) !== String(expectedPageId)) continue;
    for (const item of entry.messaging || []) {
      if (item.message?.is_echo || !item.sender?.id) continue;
      const text = item.message?.text || item.postback?.title || item.postback?.payload;
      const audio = parseMessengerAudioAttachment(item.message?.attachments);
      if (!audio && (typeof text !== 'string' || !text.trim())) continue;
      events.push({
        senderId: String(item.sender.id),
        text: typeof text === 'string' ? text.trim() : null,
        pageId: String(entry.id),
        ...(audio ? { audio } : {}),
      });
    }
  }
  return events;
}

function normalizeMediaType(value) {
  const mediaType = String(value || '').split(';', 1)[0].trim().toLowerCase();
  const aliases = {
    'audio/mp3': 'audio/mpeg',
    'audio/x-m4a': 'audio/m4a',
    'application/ogg': 'audio/ogg',
  };
  return aliases[mediaType] || mediaType;
}

// Messenger delivers a short-lived download URL in the attachment payload.
// Some webhook versions omit `type: audio`, so MIME type is also considered.
function parseMessengerAudioAttachment(attachments) {
  if (!Array.isArray(attachments)) return null;

  for (const attachment of attachments) {
    const payload = attachment?.payload || {};
    const mediaType = normalizeMediaType(
      attachment?.mime_type || payload.mime_type || payload.content_type
    );
    const type = String(attachment?.type || '').toLowerCase();
    if (type !== 'audio' && !mediaType.startsWith('audio/')) continue;

    const url = typeof payload.url === 'string' ? payload.url : '';
    if (!url) continue;
    return {
      url,
      mediaType: mediaType || 'audio/ogg',
      fileSize: Number(payload.file_size || payload.size || attachment?.file_size || 0),
      durationSeconds: Number(payload.duration || attachment?.duration || 0),
      filename: String(payload.filename || attachment?.name || 'messenger-voice.ogg'),
    };
  }
  return null;
}

function assertHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Messenger media URL is invalid.');
  }
  if (url.protocol !== 'https:') throw new Error('Messenger media URL must use HTTPS.');
  return url.toString();
}

function filenameForMediaType(filename, mediaType) {
  const extensions = {
    'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/m4a': 'm4a',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
    'audio/opus': 'ogg', 'audio/wav': 'wav', 'audio/webm': 'webm',
  };
  const extension = extensions[mediaType] || 'ogg';
  const stem = String(filename || 'messenger-voice').replace(/\.[a-z0-9]{1,8}$/i, '');
  return `${stem || 'messenger-voice'}.${extension}`;
}

// The media bytes, temporary URL and page token remain in memory only for
// this turn. Downloads are bounded before and after reading the body.
async function downloadMessengerMedia(accessToken, media, fetchImpl = globalThis.fetch) {
  if (!accessToken || !media?.url || typeof fetchImpl !== 'function') {
    throw new Error('Messenger media is unavailable.');
  }
  const response = await fetchImpl(assertHttpsUrl(media.url), {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Messenger media download failed.');

  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  const declaredSize = Number(media.fileSize || 0);
  if (contentLength > MAX_AUDIO_BYTES || declaredSize > MAX_AUDIO_BYTES) {
    throw new TranscriptionError('AUDIO_TOO_LARGE', 'Голосове повідомлення занадто велике.');
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length > MAX_AUDIO_BYTES) {
    throw new TranscriptionError('AUDIO_TOO_LARGE', 'Голосове повідомлення занадто велике.');
  }
  const mediaType = normalizeMediaType(response.headers?.get?.('content-type') || media.mediaType) || 'audio/ogg';
  return {
    audio,
    mediaType,
    fileSize: declaredSize || contentLength || audio.length,
    durationSeconds: Number(media.durationSeconds || 0),
    filename: filenameForMediaType(media.filename, mediaType),
  };
}

// Text and voice both become one normal user text before entering the shared
// concierge/history pipeline. This preserves tenant, channel and chat scope.
async function prepareMessengerIncomingText({
  event,
  accessToken,
  downloadMedia = downloadMessengerMedia,
  transcribe = transcribeAudio,
} = {}) {
  if (event?.text) return String(event.text).trim();
  if (!event?.audio) return null;
  if (event.audio.durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
    throw new TranscriptionError('AUDIO_TOO_LONG', 'Голосове повідомлення занадто довге.');
  }
  const media = await downloadMedia(accessToken, event.audio);
  if (media.durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
    throw new TranscriptionError('AUDIO_TOO_LONG', 'Голосове повідомлення занадто довге.');
  }
  return transcribe({
    audio: media.audio,
    mediaType: media.mediaType,
    filename: media.filename,
    durationSeconds: media.durationSeconds,
  });
}

async function sendMessengerMessage(accessToken, recipientId, text, graphVersion = 'v24.0') {
  const response = await fetch(`https://graph.facebook.com/${graphVersion}/me/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { text: String(text).slice(0, 2000) },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Messenger send failed: ${response.status} ${body.slice(0, 500)}`);
  }
  return response.json();
}

module.exports = {
  VOICE_PROCESSING_FALLBACK,
  safeEqual,
  verifyMessengerSignature,
  parseMessengerEvents,
  parseMessengerAudioAttachment,
  normalizeMediaType,
  downloadMessengerMedia,
  prepareMessengerIncomingText,
  sendMessengerMessage,
};
