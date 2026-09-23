/* ============================================================
   StayAI — інтеграція з Viber Bot API (REST, аналогічно telegram.js)

   ВАЖЛИВО: цей модуль написано за офіційною документацією Viber REST
   API (chatapi.viber.com), але не протестовано на живому акаунті —
   комерційну заявку на бота ще не схвалено (див. план, Фаза 6).
   Коли заявку схвалять і в кабінеті буде вставлено реальний токен —
   перевірте перше повідомлення в реальному Viber-чаті і за потреби
   звіртесь із актуальною документацією Viber.
   ============================================================ */

const crypto = require('crypto');

const VIBER_API_BASE = 'https://chatapi.viber.com/pa';
const MAX_VIBER_TEXT_LENGTH = 7000;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Viber signs every callback with HMAC-SHA256(auth token, raw JSON body).
// Verify before parsing or acknowledging a message so an arbitrary caller
// cannot inject guest text into another hotel's AI conversation.
function verifyViberSignature(rawBody, signatureHeader, botToken) {
  if (!rawBody || !signatureHeader || !botToken) return false;
  const expected = crypto.createHmac('sha256', botToken).update(rawBody, 'utf8').digest('hex');
  return safeEqual(signatureHeader, expected);
}

/**
 * Дістає chatId (sender id) і текст повідомлення з "сирого" вебхука Viber.
 * Повертає null для службових подій (webhook-перевірка, підписка тощо)
 * і для нетекстових повідомлень (стікери, фото і т.д.).
 */
function parseViberUpdate(update) {
  if (!update || update.event !== 'message') return null;
  const msg = update.message;
  if (!msg || msg.type !== 'text' || typeof msg.text !== 'string') return null;
  const senderId = update.sender && update.sender.id;
  if (!senderId) return null;

  return {
    chatId: senderId,
    text: msg.text,
    fromName: (update.sender && update.sender.name) || null,
  };
}

/**
 * Надсилає текстове повідомлення конкретному користувачу Viber
 * через бота конкретного готелю.
 */
async function sendViberMessage(botToken, receiverId, text, senderName = 'StayAI') {
  const res = await fetch(`${VIBER_API_BASE}/send_message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Viber-Auth-Token': botToken },
    body: JSON.stringify({
      receiver: receiverId,
      type: 'text',
      text: String(text || '').slice(0, MAX_VIBER_TEXT_LENGTH),
      sender: { name: senderName.slice(0, 28) },
    }),
  });

  const data = await res.json().catch(() => null);
  if (!data || typeof data.status !== 'number') {
    throw new Error(`Viber sendMessage failed: HTTP ${res.status}`);
  }
  if (data.status !== 0) {
    throw new Error(`Viber sendMessage failed: ${data.status_message || data.status}`);
  }
  return data;
}

/**
 * Реєструє webhook для конкретного бота готелю. Викликається з
 * особистого кабінету при підключенні бота (вставили токен → кнопка
 * "Підключити").
 */
async function setViberWebhook(botToken, publicUrl) {
  const res = await fetch(`${VIBER_API_BASE}/set_webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Viber-Auth-Token': botToken },
    body: JSON.stringify({
      url: publicUrl,
      event_types: ['message', 'conversation_started', 'subscribed'],
    }),
  });

  const data = await res.json().catch(() => null);
  if (!data || typeof data.status !== 'number') {
    throw new Error(`Viber setWebhook failed: HTTP ${res.status}`);
  }
  return data;
}

module.exports = {
  safeEqual,
  verifyViberSignature,
  parseViberUpdate,
  sendViberMessage,
  setViberWebhook,
  MAX_VIBER_TEXT_LENGTH,
};
