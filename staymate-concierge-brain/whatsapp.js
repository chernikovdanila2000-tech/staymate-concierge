const crypto = require('crypto');

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyWhatsAppSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret || !signatureHeader.startsWith('sha256=')) {
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

function parseWhatsAppEvents(payload) {
  if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    return [];
  }
  const events = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;

      const value = change.value || {};
      const phoneNumberId = String(value.metadata?.phone_number_id || '').trim();
      if (!phoneNumberId || !Array.isArray(value.messages)) continue;

      for (const message of value.messages) {
        if (!message?.from) continue;

        let text = null;
        let audio = null;
        if (message.type === 'text') {
          text = message.text?.body || '';
        } else if (message.type === 'button') {
          text = message.button?.text || message.button?.payload || '';
        } else if (message.type === 'interactive') {
          text =
            message.interactive?.button_reply?.title ||
            message.interactive?.button_reply?.id ||
            message.interactive?.list_reply?.title ||
            message.interactive?.list_reply?.id ||
            '';
        } else if (message.type === 'audio' && message.audio?.id) {
          audio = {
            mediaId: String(message.audio.id),
            mediaType: normalizeMediaType(message.audio.mime_type),
          };
        }
        if (!audio && (typeof text !== 'string' || !text.trim())) continue;

        events.push({
          phoneNumberId,
          senderId: String(message.from),
          text: typeof text === 'string' ? text.trim() : null,
          audio,
          messageId: String(message.id || ''),
        });
      }
    }
  }

  return events;
}

function normalizeMediaType(value) {
  return String(value || 'audio/ogg').split(';', 1)[0].trim().toLowerCase() || 'audio/ogg';
}

/**
 * Downloads Meta-hosted WhatsApp media after the caller has applied the
 * property access gate. The temporary URL and bearer token stay in memory
 * only and are never logged.
 */
async function downloadWhatsAppMedia(
  accessToken,
  mediaId,
  phoneNumberId,
  graphVersion = 'v24.0',
  fetchImpl = globalThis.fetch
) {
  if (!accessToken || !mediaId || !phoneNumberId || typeof fetchImpl !== 'function') {
    throw new Error('WhatsApp media is unavailable.');
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };
  const metadataResponse = await fetchImpl(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(phoneNumberId)}`,
    { headers: authHeaders }
  );
  if (!metadataResponse.ok) throw new Error('WhatsApp media metadata request failed.');

  const metadata = await metadataResponse.json();
  const mediaUrl = metadata?.url;
  if (typeof mediaUrl !== 'string') throw new Error('WhatsApp did not provide a media URL.');

  let parsedUrl;
  try {
    parsedUrl = new URL(mediaUrl);
  } catch {
    throw new Error('WhatsApp provided an invalid media URL.');
  }
  if (parsedUrl.protocol !== 'https:') throw new Error('WhatsApp media URL must use HTTPS.');

  const mediaResponse = await fetchImpl(mediaUrl, {
    headers: authHeaders,
    redirect: 'error',
  });
  if (!mediaResponse.ok) throw new Error('WhatsApp media download failed.');

  return {
    audio: Buffer.from(await mediaResponse.arrayBuffer()),
    mediaType: normalizeMediaType(metadata.mime_type || mediaResponse.headers?.get?.('content-type')),
    fileSize: Number(metadata.file_size || 0),
  };
}

async function sendWhatsAppMessage(
  accessToken,
  phoneNumberId,
  recipientId,
  text,
  graphVersion = 'v24.0'
) {
  const response = await fetch(
    `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(recipientId),
        type: 'text',
        text: {
          preview_url: false,
          body: String(text).slice(0, 4096),
        },
      }),
    }
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`WhatsApp send failed: ${response.status} ${body.slice(0, 500)}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    return { ok: true };
  }
}

module.exports = {
  verifyWhatsAppSignature,
  parseWhatsAppEvents,
  downloadWhatsAppMedia,
  sendWhatsAppMessage,
};
