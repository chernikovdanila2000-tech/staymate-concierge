/* ============================================================
   StayMate — інтеграція з Telegram Bot API

   Дві функції:
   - parseTelegramUpdate(update): дістає { chatId, text } з того,
     що присилає Telegram у вебхуку
   - sendTelegramMessage(chatId, text): відправляє відповідь
     назад у чат гостя через Telegram Bot API

   Потрібна змінна оточення TELEGRAM_BOT_TOKEN (токен від @BotFather).
   ============================================================ */

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

function getBotToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN не встановлено в змінних оточення.');
  }
  return token;
}

/**
 * Дістає chatId і текст повідомлення з "сирого" тіла вебхука Telegram.
 * Повертає null, якщо це не текстове повідомлення (наприклад, стікер,
 * фото без підпису, службове повідомлення тощо) — такі апдейти зараз
 * просто ігноруємо.
 */
function parseTelegramUpdate(update) {
  const message = update && update.message;
  if (!message || typeof message.text !== 'string') {
    return null;
  }
  return {
    chatId: message.chat.id,
    text: message.text,
    // Корисно для мультитенантності пізніше: можна прив'язати
    // conversationsByUser до `${botUsername}:${chatId}`, якщо один
    // сервер обслуговуватиме кількох ботів різних готелів.
    fromName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || null,
  };
}

/**
 * Надсилає текстове повідомлення в чат Telegram.
 */
async function sendTelegramMessage(chatId, text) {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}${token}/sendMessage`;

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
 * Реєструє webhook в Telegram — каже боту слати всі апдейти на нашу
 * адресу. Викликати один раз (вручну або скриптом) після деплою,
 * не на кожен запуск сервера.
 *
 *   node -e "require('./telegram').setWebhook('https://ваш-сервер.up.railway.app/webhook/telegram')"
 */
async function setWebhook(publicUrl) {
  const token = getBotToken();
  const url = `${TELEGRAM_API_BASE}${token}/setWebhook`;

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
