const crypto = require('crypto');

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

function parseMessengerEvents(payload, expectedPageId) {
  if (!payload || payload.object !== 'page' || !Array.isArray(payload.entry)) return [];
  const events = [];
  for (const entry of payload.entry) {
    if (expectedPageId && String(entry.id) !== String(expectedPageId)) continue;
    for (const item of entry.messaging || []) {
      if (item.message?.is_echo || !item.sender?.id) continue;
      const text = item.message?.text || item.postback?.title || item.postback?.payload;
      if (typeof text !== 'string' || !text.trim()) continue;
      events.push({ senderId: String(item.sender.id), text: text.trim() });
    }
  }
  return events;
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

module.exports = { safeEqual, verifyMessengerSignature, parseMessengerEvents, sendMessengerMessage };
