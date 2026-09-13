/* ============================================================
   StayMate — інтеграція з Telegram Bot API (мультитенантна)

   На відміну від попередньої версії, тут НЕМАЄ одного глобального
   TELEGRAM_BOT_TOKEN — кожен готель має свій власний токен (введений
   у особистому кабінеті), тому sendTelegramMessage і setWebhook
   тепер приймають токен як параметр.
   ============================================================ */

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

/**
 * Дістає chatId і текст повідомлення з "сирого" тіла вебхука Telegram.
 * Повертає null, якщо це не текстове повідомлення.
 */
function parseTelegramUpdate(update) {
  const message = update && update.message;
  if (!message || typeof message.text !== 'string') {
    return null;
  }
  return {
    chatId: message.chat.id,
    text: message.text,
    fromName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || null,
  };
}

/**
 * Надсилає текстове повідомлення в чат Telegram через бота конкретного готелю.
 */
async function sendTelegramMessage(botToken, chatId, text) {
  const url = `${TELEGRAM_API_BASE}${botToken}/sendMessage`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed: ${res.status} ${errBody}`);
  }

  return res.json();
}

/**
 * Реєструє webhook для конкретного бота готелю. Викликається з особистого
 * кабінету (клієнтський JS) при підключенні бота — але лишаємо і тут,
 * якщо знадобиться викликати вручну/зі скрипта.
 */
async function setWebhook(botToken, publicUrl) {
  const url = `${TELEGRAM_API_BASE}${botToken}/setWebhook`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: publicUrl }),
  });

  const data = await res.json();
  console.log('setWebhook response:', data);
  return data;
}

module.exports = { parseTelegramUpdate, sendTelegramMessage, setWebhook };
