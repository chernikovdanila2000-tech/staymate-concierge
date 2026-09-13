/* ============================================================
   StayMate — інтеграція з Viber Bot API (REST, аналогічно telegram.js)

   ВАЖЛИВО: цей модуль написано за офіційною документацією Viber REST
   API (chatapi.viber.com), але не протестовано на живому акаунті —
   комерційну заявку на бота ще не схвалено (див. план, Фаза 6).
   Коли заявку схвалять і в кабінеті буде вставлено реальний токен —
   перевірте перше повідомлення в реальному Viber-чаті і за потреби
   звіртесь із актуальною документацією Viber.
   ============================================================ */

const VIBER_API_BASE = 'https://chatapi.viber.com/pa';

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
async function sendViberMessage(botToken, receiverId, text, senderName = 'StayMate') {
  const res = await fetch(`${VIBER_API_BASE}/send_message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Viber-Auth-Token': botToken },
    body: JSON.stringify({
      receiver: receiverId,
      type: 'text',
      text,
      sender: { name: senderName.slice(0, 28) },
    }),
  });

  const data = await res.json();
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

  const data = await res.json();
  return data;
}

module.exports = { parseViberUpdate, sendViberMessage, setViberWebhook };
