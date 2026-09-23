const crypto = require('crypto');
const {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  TranscriptionError,
  transcribeAudio,
} = require('./transcription');

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyInstagramSignature(rawBody, signatureHeader, appSecret) {
  if (
    !signatureHeader ||
    !appSecret ||
    !signatureHeader.startsWith('sha256=')
  ) {
    return false;
  }

  const expected =
    'sha256=' +
    crypto
      .createHmac('sha256', appSecret)
      .update(rawBody, 'utf8')
      .digest('hex');

  return safeEqual(signatureHeader, expected);
}

function parseInstagramEvents(payload) {
  if (!payload || !Array.isArray(payload.entry)) return [];

  const events = [];

  for (const entry of payload.entry) {
    const accountId = String(entry?.id || '').trim();
    if (!accountId) continue;

    for (const item of entry.messaging || []) {
      if (item.message?.is_echo || !item.sender?.id) continue;

      const text =
        item.message?.text ||
        item.postback?.title ||
        item.postback?.payload;

      const audio = parseInstagramAudioAttachment(item.message?.attachments);
      if (!audio && (typeof text !== 'string' || !text.trim())) continue;

      events.push({
        // A webhook delivery can contain entries for more than one Instagram
        // professional account. Keep the source account on every event so the
        // caller always resolves the correct hotel's channel credentials.
        accountId,
        senderId: String(item.sender.id),
        text: typeof text === 'string' ? text.trim() : null,
        audio,
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

function parseInstagramAudioAttachment(attachments) {
  if (!Array.isArray(attachments)) return null;

  for (const attachment of attachments) {
    const payload = attachment?.payload || {};
    const detectedMediaType = normalizeMediaType(
      attachment?.mime_type || payload.mime_type || payload.content_type
    );
    const type = String(attachment?.type || '').toLowerCase();
    const isAudio = type === 'audio' || detectedMediaType.startsWith('audio/');
    if (!isAudio) continue;

    const url = typeof payload.url === 'string' ? payload.url : '';
    const mediaId = String(payload.id || payload.media_id || attachment?.id || '').trim();
    if (!url && !mediaId) continue;

    return {
      url,
      mediaId,
      mediaType: detectedMediaType || 'audio/ogg',
      fileSize: Number(payload.file_size || payload.size || attachment?.file_size || 0),
      durationSeconds: Number(payload.duration || attachment?.duration || 0),
      filename: String(payload.filename || attachment?.name || 'instagram-voice.ogg'),
    };
  }

  return null;
}

function assertHttpsUrl(value, source) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Instagram ${source} URL is invalid.`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Instagram ${source} URL must use HTTPS.`);
  }
  return url.toString();
}

/**
 * Downloads an Instagram audio attachment using only the temporary URL
 * supplied by Meta (or a metadata lookup for media IDs). The URL, token, and
 * bytes stay in memory for this turn and are never logged or persisted.
 */
async function downloadInstagramMedia(
  accessToken,
  media,
  graphVersion = 'v24.0',
  fetchImpl = globalThis.fetch
) {
  if (!accessToken || !media || typeof fetchImpl !== 'function') {
    throw new Error('Instagram media is unavailable.');
  }

  const headers = { Authorization: `Bearer ${accessToken}` };
  let mediaUrl = '';
  let metadata = {};

  // A messaging attachment may include both a preview/download URL and an
  // immutable media ID. Prefer the documented Graph media lookup when the ID
  // exists: attachment URLs can be short-lived wrappers rather than the raw
  // audio bytes, which makes downstream transcription reject the payload.
  if (media.mediaId) {
    const metadataResponse = await fetchImpl(
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(media.mediaId)}?fields=url,mime_type,file_size,duration`,
      { headers }
    );
    if (metadataResponse.ok) {
      metadata = await metadataResponse.json();
      mediaUrl = metadata?.url || '';
    } else if (!media.url) {
      throw new Error('Instagram media metadata request failed.');
    }
  }
  mediaUrl = mediaUrl || media.url || '';

  const safeUrl = assertHttpsUrl(mediaUrl, 'media');
  const response = await fetchImpl(safeUrl, { headers, redirect: 'error' });
  if (!response.ok) throw new Error('Instagram media download failed.');

  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  const declaredSize = Number(metadata.file_size || media.fileSize || 0);
  if (contentLength > MAX_AUDIO_BYTES || declaredSize > MAX_AUDIO_BYTES) {
    throw new TranscriptionError('AUDIO_TOO_LARGE', 'Голосове повідомлення занадто велике.');
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length > MAX_AUDIO_BYTES) {
    throw new TranscriptionError('AUDIO_TOO_LARGE', 'Голосове повідомлення занадто велике.');
  }

  return {
    audio,
    mediaType: normalizeMediaType(metadata.mime_type || media.mediaType || response.headers?.get?.('content-type')) || 'audio/ogg',
    fileSize: declaredSize || contentLength || audio.length,
    durationSeconds: Number(metadata.duration || media.durationSeconds || 0),
    filename: media.filename || 'instagram-voice.ogg',
  };
}

/**
 * Converts Instagram text or audio into the one internal user-text format
 * used by runConciergeTurn. This keeps Instagram voice messages on the same
 * history, access, takeover, and AI route as ordinary text messages.
 */
async function prepareInstagramIncomingText({
  event,
  accessToken,
  graphVersion = 'v24.0',
  downloadMedia = downloadInstagramMedia,
  transcribe = transcribeAudio,
} = {}) {
  if (event?.text) return String(event.text).trim();
  if (!event?.audio) return null;
  if (event.audio.durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
    throw new TranscriptionError('AUDIO_TOO_LONG', 'Голосове повідомлення занадто довге.');
  }

  const media = await downloadMedia(accessToken, event.audio, graphVersion);
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

async function sendInstagramMessage(
  accessToken,
  instagramAccountId,
  recipientId,
  text,
  graphVersion = 'v24.0',
  fetchImpl = fetch
) {
  const url =
    `https://graph.facebook.com/${graphVersion}/me/messages`;

  console.log('[instagram] Sending reply:', {
    recipientId,
    textLength: String(text).length,
  });

  const response = await fetchImpl(url, {
    method: 'POST',

    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },

    body: JSON.stringify({
      recipient: {
        id: String(recipientId),
      },

      messaging_type: 'RESPONSE',

      message: {
        text: String(text).slice(0, 1000),
      },
    }),
  });

  const body = await response.text();

  if (!response.ok) {
    // Meta's body can contain customer or account metadata. Keep logs useful
    // without copying external response contents into production logs.
    console.error('[instagram] Send API error:', response.status);

    throw new Error(
      `Instagram send failed: ${response.status}`
    );
  }

  console.log('[instagram] Reply sent successfully');

  try {
    return JSON.parse(body);
  } catch {
    return { ok: true };
  }
}

module.exports = {
  safeEqual,
  verifyInstagramSignature,
  parseInstagramEvents,
  parseInstagramAudioAttachment,
  normalizeMediaType,
  downloadInstagramMedia,
  prepareInstagramIncomingText,
  sendInstagramMessage,
};
