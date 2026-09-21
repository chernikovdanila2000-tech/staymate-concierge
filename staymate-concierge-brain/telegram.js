/* ============================================================
   StayAI — інтеграція з Telegram Bot API (мультитенантна)

   На відміну від попередньої версії, тут НЕМАЄ одного глобального
   TELEGRAM_BOT_TOKEN — кожен готель має свій власний токен (введений
   у особистому кабінеті), тому sendTelegramMessage і setWebhook
   тепер приймають токен як параметр.
   ============================================================ */

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

/**
 * Дістає chatId і текст повідомлення з "сирого" тіла вебхука Telegram.
 * Повертає null, якщо це не текстове або голосове повідомлення.
 */
function parseTelegramUpdate(update) {
  const message = update && update.message;
  if (!message) {
    return null;
  }

  // Telegram records made with the microphone arrive as `voice`; files sent
  // through the attachment picker arrive as `audio`.  Both are guest voice
  // input for StayAI and should follow the same transcription path.
  const voice = message.voice || message.audio;
  if (typeof message.text !== 'string' && !voice?.file_id) return null;

  return {
    chatId: message.chat.id,
    text: typeof message.text === 'string' ? message.text : null,
    voice: voice?.file_id ? {
      fileId: voice.file_id,
      fileSize: Number(voice.file_size || 0),
      mediaType: String(voice.mime_type || 'audio/ogg').toLowerCase(),
    } : null,
    fromName: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || null,
  };
}

/** Downloads an audio file only after the caller has checked its size/type. */
async function downloadTelegramFile(botToken, fileId, fetchImpl = globalThis.fetch) {
  const metadataResponse = await fetchImpl(`${TELEGRAM_API_BASE}${botToken}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!metadataResponse.ok) throw new Error('Telegram не надав голосове повідомлення.');

  const metadata = await metadataResponse.json();
  const filePath = metadata?.result?.file_path;
  if (!filePath || typeof filePath !== 'string') throw new Error('Telegram не повернув шлях до голосового повідомлення.');

  const fileResponse = await fetchImpl(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
  if (!fileResponse.ok) throw new Error('Не вдалося завантажити голосове повідомлення з Telegram.');
  return Buffer.from(await fileResponse.arrayBuffer());
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

module.exports = { parseTelegramUpdate, downloadTelegramFile, sendTelegramMessage, setWebhook };
