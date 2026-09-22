const crypto = require('crypto');

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

      if (typeof text !== 'string' || !text.trim()) continue;

      events.push({
        // A webhook delivery can contain entries for more than one Instagram
        // professional account. Keep the source account on every event so the
        // caller always resolves the correct hotel's channel credentials.
        accountId,
        senderId: String(item.sender.id),
        text: text.trim(),
      });
    }
  }

  return events;
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
  sendInstagramMessage,
};
