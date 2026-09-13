/* ============================================================
   StayMate — сервер ШІ-адміністратора (мультитенантна версія)

   Один сервер обслуговує БАГАТО готелів одночасно. Кожен готель
   має свій Telegram-бот; webhook для нього реєструється на адресу
   /webhook/telegram/<property_id> — за цим property_id сервер
   дістає з таблиці properties (Supabase) назву готелю і токен
   бота, і вже з цими даними веде розмову й надсилає відповідь.

   Запуск:  node server.js
   ============================================================ */

const http = require('http');
const crypto = require('crypto');
const { runConciergeTurn } = require('./claude-client');
const { parseTelegramUpdate, sendTelegramMessage } = require('./telegram');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const WFP_MERCHANT_SECRET = process.env.WAYFORPAY_MERCHANT_SECRET || 'flk3409refn54t54t*FNJRET';

const PORT = process.env.PORT || 3000;

// Історія розмов по кожному гостю кожного готелю зберігається в пам'яті процесу.
// TODO: для продакшену перенести в Supabase (таблиця conversations).
const conversationsByUser = new Map();

// Проста кеш-пам'ять даних готелю на 60 секунд, щоб не бити Supabase
// на кожне повідомлення від активного гостя.
const propertyCache = new Map(); // property_id -> { data, expiresAt }
const PROPERTY_CACHE_TTL_MS = 60 * 1000;

async function getProperty(propertyId) {
  const cached = propertyCache.get(propertyId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const { data, error } = await supabase
    .from('properties')
    .select('property_id, hotel_name, telegram_bot_token, subscription_status')
    .eq('property_id', propertyId)
    .maybeSingle();

  if (error) {
    console.error('[getProperty] Supabase error:', error);
    return null;
  }
  if (!data) return null;

  propertyCache.set(propertyId, { data, expiresAt: Date.now() + PROPERTY_CACHE_TTL_MS });
  return data;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  // POST /chat — тестовий роут без Telegram, для перевірки "мозку" напряму.
  // Тепер вимагає propertyId у тілі запиту.
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch (e) {
        return sendJson(res, 400, { error: 'Некоректний JSON у тілі запиту.' });
      }

      const { userId, message, propertyId } = parsed;
      if (!userId || !message || !propertyId) {
        return sendJson(res, 400, { error: 'Потрібні поля userId, message і propertyId.' });
      }

      const property = await getProperty(propertyId);
      if (!property) {
        return sendJson(res, 404, { error: `Готель з property_id="${propertyId}" не знайдено.` });
      }

      const historyKey = `chat:${propertyId}:${userId}`;
      const history = conversationsByUser.get(historyKey) || [];
      history.push({ role: 'user', content: message });

      try {
        const { replyText, updatedHistory } = await runConciergeTurn(history, {
          propertyId,
          propertyName: property.hotel_name,
        });
        conversationsByUser.set(historyKey, updatedHistory);
        return sendJson(res, 200, { reply: replyText });
      } catch (err) {
        console.error('Concierge error:', err);
        return sendJson(res, 500, { error: 'Помилка ШІ-адміністратора: ' + String(err.message || err) });
      }
    });
    return;
  }

  // POST /webhook/telegram/<property_id> — вебхук конкретного готелю.
  if (req.method === 'POST' && req.url.startsWith('/webhook/telegram/')) {
    const propertyId = decodeURIComponent(req.url.slice('/webhook/telegram/'.length));

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      // Telegram чекає швидку відповідь 200 — підтверджуємо прийом одразу,
      // а обробляємо і відповідаємо гостю вже асинхронно.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');

      let update;
      try {
        update = JSON.parse(body || '{}');
      } catch (e) {
        console.error('Telegram webhook: невалідний JSON');
        return;
      }

      const parsed = parseTelegramUpdate(update);
      if (!parsed) return; // не текстове повідомлення — ігноруємо

      const property = await getProperty(propertyId);
      if (!property || !property.telegram_bot_token) {
        console.error(`Telegram webhook: готель "${propertyId}" не знайдено або бот не підключено.`);
        return;
      }

      const { chatId, text } = parsed;
      const historyKey = `telegram:${propertyId}:${chatId}`;
      const history = conversationsByUser.get(historyKey) || [];
      history.push({ role: 'user', content: text });

      try {
        const { replyText, updatedHistory } = await runConciergeTurn(history, {
          propertyId,
          propertyName: property.hotel_name,
        });
        conversationsByUser.set(historyKey, updatedHistory);
        await sendTelegramMessage(property.telegram_bot_token, chatId, replyText);
      } catch (err) {
        console.error(`Concierge error (telegram, ${propertyId}):`, err);
        try {
          await sendTelegramMessage(
            property.telegram_bot_token,
            chatId,
            'Вибачте, сталася технічна помилка. Спробуйте, будь ласка, ще раз трохи пізніше.'
          );
        } catch (e2) {
          console.error('Не вдалося надіслати повідомлення про помилку в Telegram:', e2);
        }
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook/wayforpay') {
    let rawBody = '';
    req.on('data', chunk => { rawBody += chunk; });
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (err) {
        console.error('WayForPay webhook: невалідний JSON —', err.message);
        res.writeHead(400);
        return res.end();
      }

      const { orderReference, transactionStatus } = payload;
      console.log(`WayForPay webhook: ${orderReference} → ${transactionStatus}`);

      if (orderReference && transactionStatus === 'Approved') {
        const { error } = await supabase
          .from('bookings')
          .update({ status: 'paid' })
          .eq('booking_id', orderReference);
        if (error) {
          console.error('WayForPay webhook: не вдалося оновити статус бронювання', orderReference, error);
        } else {
          console.log(`WayForPay webhook: бронювання ${orderReference} оплачено ✅`);
        }
      }

      const time = Math.floor(Date.now() / 1000);
      const signature = crypto
        .createHmac('md5', WFP_MERCHANT_SECRET)
        .update(`${orderReference};accept;${time}`)
        .digest('hex');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ orderReference, status: 'accept', time, signature }));
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`StayMate concierge server running on http://localhost:${PORT}`);
});
