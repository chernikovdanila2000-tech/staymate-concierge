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
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';
const SUPPORTED_MEDIA_TYPES = new Set([
  'audio/aac', 'audio/flac', 'audio/m4a', 'audio/mpeg', 'audio/mp4',
  'audio/ogg', 'audio/opus', 'audio/wav', 'audio/webm',
]);

class TranscriptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
  }
}

function safeFilename(filename, mediaType) {
  const fallback = mediaType === 'audio/ogg' ? 'voice.ogg' : 'voice.webm';
  const cleaned = String(filename || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.slice(0, 120) || fallback;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
    throw new TranscriptionError('UNSUPPORTED_MEDIA_TYPE', 'Этот формат голосового сообщения пока не поддерживается.');
  }

  const form = new FormData();
  form.append('file', new Blob([audio], { type: mediaType }), safeFilename(filename, mediaType));
  form.append('model', String(model));
  if (language) form.append('language', String(language).slice(0, 12));

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch {
    throw new TranscriptionError('TRANSCRIPTION_NETWORK_ERROR', 'Не удалось связаться с сервисом распознавания.');
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Keep a customer-safe error below; do not expose a provider response.
  }
  if (!response.ok) {
    throw new TranscriptionError('TRANSCRIPTION_PROVIDER_ERROR', 'Сервис распознавания не смог обработать голосовое сообщение.');
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
  SUPPORTED_MEDIA_TYPES,
  TranscriptionError,
  normalizeText,
  transcribeAudio,
};
