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

        let text = '';
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
        }
        if (typeof text !== 'string' || !text.trim()) continue;

        events.push({
          phoneNumberId,
          senderId: String(message.from),
          text: text.trim(),
          messageId: String(message.id || ''),
        });
      }
    }
  }

  return events;
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
  sendWhatsAppMessage,
};
