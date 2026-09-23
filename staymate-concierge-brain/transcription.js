/*
 * Provider-neutral voice transcription boundary.
 *
 * The caller supplies an audio Buffer already received from a channel.  This
 * module performs only the safe, common operation: validates the file and
 * calls an OpenAI-compatible multipart transcription endpoint.  No channel
 * token, provider key, or audio body is ever logged.
 */

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS = 10 * 60;
// A provider request must never hold a channel webhook open indefinitely.
// Meta retries slow webhooks and a guest otherwise gets neither an answer nor
// the safe fallback message.
const TRANSCRIPTION_TIMEOUT_MS = 45 * 1000;
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';
const SUPPORTED_MEDIA_TYPES = new Set([
  'audio/aac', 'audio/flac', 'audio/m4a', 'audio/mpeg', 'audio/mp4',
  'audio/ogg', 'audio/opus', 'audio/wav', 'audio/webm',
]);

class TranscriptionError extends Error {
  constructor(code, message, { providerStatus, providerReason } = {}) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
    // Status is intentionally the only provider diagnostic retained. It lets
    // operators distinguish credentials, billing and format errors without
    // logging provider bodies, audio, or credentials.
    if (Number.isInteger(providerStatus) && providerStatus >= 100 && providerStatus <= 599) {
      this.providerStatus = providerStatus;
    }
    if (providerReason) this.providerReason = providerReason;
  }
}

function audioExtension(mediaType) {
  return {
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/m4a': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
  }[mediaType] || 'webm';
}

function safeFilename(filename, mediaType) {
  const extension = audioExtension(mediaType);
  const cleaned = String(filename || 'voice').replace(/[^a-zA-Z0-9._-]/g, '_');
  const stem = cleaned.replace(/\.[a-zA-Z0-9]{1,8}$/, '').slice(0, 112) || 'voice';
  return `${stem}.${extension}`;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Instagram's CDN occasionally labels a valid voice file as
// application/octet-stream. Identify only well-known audio containers from
// their binary signatures; an unknown file still remains rejected.
function detectAudioMediaType(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 4) return null;
  if (audio.subarray(0, 4).equals(Buffer.from('OggS'))) return 'audio/ogg';
  if (audio.subarray(0, 4).equals(Buffer.from('fLaC'))) return 'audio/flac';
  if (audio.subarray(0, 4).equals(Buffer.from('RIFF')) && audio.subarray(8, 12).equals(Buffer.from('WAVE'))) return 'audio/wav';
  if (audio.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'audio/webm';
  if (audio.subarray(0, 3).equals(Buffer.from('ID3')) || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (audio.length >= 12 && audio.subarray(4, 8).equals(Buffer.from('ftyp'))) {
    return audio.subarray(8, 12).equals(Buffer.from('M4A ')) ? 'audio/m4a' : 'audio/mp4';
  }
  return null;
}

// Provider messages may contain request-specific information. Keep production
// observability useful without persisting those messages or any media data.
function safeProviderReason(payload) {
  const error = payload && typeof payload === 'object' ? payload.error : null;
  const source = `${error?.type || ''} ${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  if (/file|audio/.test(source) && /format|decode|corrupt|invalid/.test(source)) return 'invalid_audio_payload';
  if (/model/.test(source) && /access|exist|available|found/.test(source)) return 'model_unavailable';
  if (/response_format/.test(source)) return 'invalid_response_format';
  if (/language/.test(source)) return 'invalid_language';
  if (/quota|billing|credit|rate.limit/.test(source)) return 'provider_quota';
  if (/api.key|authentication|unauthoriz/.test(source)) return 'provider_auth';
  return error?.type === 'invalid_request_error' ? 'invalid_request' : undefined;
}

async function transcribeAudio({
  audio,
  mediaType,
  filename,
  language,
  durationSeconds,
  endpoint = process.env.TRANSCRIPTION_API_URL || DEFAULT_ENDPOINT,
  apiKey = process.env.TRANSCRIPTION_API_KEY || '',
  model = process.env.TRANSCRIPTION_MODEL || DEFAULT_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = TRANSCRIPTION_TIMEOUT_MS,
} = {}) {
  if (!apiKey) {
    throw new TranscriptionError('TRANSCRIPTION_NOT_CONFIGURED', 'Распознавание голосовых сообщений ещё не подключено.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TranscriptionError('TRANSCRIPTION_UNAVAILABLE', 'Распознавание голосовых сообщений временно недоступно.');
  }
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    throw new TranscriptionError('INVALID_AUDIO', 'Не удалось прочитать голосовое сообщение.');
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    throw new TranscriptionError('AUDIO_TOO_LARGE', 'Голосовое сообщение слишком большое.');
  }
  if (Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > MAX_AUDIO_DURATION_SECONDS) {
    throw new TranscriptionError('AUDIO_TOO_LONG', 'Голосове повідомлення занадто довге.');
  }
  const detectedMediaType = detectAudioMediaType(audio);
  const resolvedMediaType = detectedMediaType || mediaType;
  if (!SUPPORTED_MEDIA_TYPES.has(resolvedMediaType)) {
    throw new TranscriptionError('UNSUPPORTED_MEDIA_TYPE', 'Этот формат голосового сообщения пока не поддерживается.');
  }

  const form = new FormData();
  form.append('file', new Blob([audio], { type: resolvedMediaType }), safeFilename(filename, resolvedMediaType));
  form.append('model', String(model));
  // gpt-4o transcribe models only return JSON. Be explicit instead of relying
  // on endpoint defaults that can vary between provider versions.
  form.append('response_format', 'json');
  if (language) form.append('language', String(language).slice(0, 12));

  let response;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const safeTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : TRANSCRIPTION_TIMEOUT_MS;
  const timeout = controller
    ? setTimeout(() => controller.abort(), safeTimeoutMs)
    : null;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch {
    if (controller?.signal.aborted) {
      throw new TranscriptionError('TRANSCRIPTION_TIMEOUT', 'Распознавание голосового сообщения заняло слишком много времени.');
    }
    throw new TranscriptionError('TRANSCRIPTION_NETWORK_ERROR', 'Не удалось связаться с сервисом распознавания.');
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Keep a customer-safe error below; do not expose a provider response.
  }
  if (!response.ok) {
    throw new TranscriptionError(
      'TRANSCRIPTION_PROVIDER_ERROR',
      'Сервис распознавания не смог обработать голосовое сообщение.',
      { providerStatus: response.status, providerReason: safeProviderReason(payload) }
    );
  }

  const text = normalizeText(payload.text);
  if (!text) {
    throw new TranscriptionError('EMPTY_TRANSCRIPTION', 'Не удалось распознать речь в голосовом сообщении.');
  }
  return text;
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  TRANSCRIPTION_TIMEOUT_MS,
  SUPPORTED_MEDIA_TYPES,
  TranscriptionError,
  detectAudioMediaType,
  normalizeText,
  safeProviderReason,
  transcribeAudio,
};
