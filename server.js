/* ============================================================
   StayMate — сервер ШІ-адміністратора (демо-каркас)
   Зараз приймає POST /chat з { userId, message } і повертає
   відповідь ШІ — зручно для тестування "мозку" окремо від
   конкретного месенджера. Коли підключатимемо Telegram/WhatsApp,
   додамо окремий webhook-роут, який буде викликати ту саму
   runConciergeTurn() і лише перекладати формат Telegram/WhatsApp
   у { userId, message } і назад.

   Запуск:  ANTHROPIC_API_KEY=sk-ant-... node server.js
   Тест:    curl -X POST http://localhost:3000/chat \
              -H "Content-Type: application/json" \
              -d '{"userId":"guest1","message":"Привіт, чи є вільний номер на 2 дорослих з 10 по 12 вересня?"}'
   ============================================================ */

const http = require('http');
const crypto = require('crypto');
const { runConciergeTurn } = require('./claude-client');
const { parseTelegramUpdate, sendTelegramMessage } = require('./telegram');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const WFP_MERCHANT_SECRET = process.env.WAYFORPAY_MERCHANT_SECRET || 'flk3409refn54t54t*FNJRET';

const PORT = process.env.PORT || 3000;

// Історія розмов по кожному гостю зберігається в пам'яті процесу.
// TODO: для продакшену перенести в Supabase (таблиця conversations),
// інакше історія втрачається при перезапуску сервера і не працює
// при кількох інстансах сервера одночасно.
const conversationsByUser = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
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

      const { userId, message } = parsed;
      if (!userId || !message) {
        return sendJson(res, 400, { error: 'Потрібні поля userId і message.' });
      }

      const history = conversationsByUser.get(userId) || [];
      history.push({ role: 'user', content: message });

      try {
        const { replyText, updatedHistory } = await runConciergeTurn(history);
        conversationsByUser.set(userId, updatedHistory);
        return sendJson(res, 200, { reply: replyText });
      } catch (err) {
        console.error('Concierge error:', err);
        return sendJson(res, 500, { error: 'Помилка ШІ-адміністратора: ' + String(err.message || err) });
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook/telegram') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      // Telegram чекає відповідь 200 швидко і не хоче отримувати
      // помилки в тілі — тому спочатку підтверджуємо прийом,
      // а вже потім (асинхронно) обробляємо і шлемо відповідь
      // окремим запитом через sendTelegramMessage.
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

      const { chatId, text } = parsed;
      const userId = `telegram:${chatId}`;
      const history = conversationsByUser.get(userId) || [];
      history.push({ role: 'user', content: text });

      try {
        const { replyText, updatedHistory } = await runConciergeTurn(history);
        conversationsByUser.set(userId, updatedHistory);
        await sendTelegramMessage(chatId, replyText);
      } catch (err) {
        console.error('Concierge error (telegram):', err);
        try {
          await sendTelegramMessage(chatId, 'Вибачте, сталася технічна помилка. Спробуйте, будь ласка, ще раз трохи пізніше.');
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

      // WayForPay вимагає підтвердження отримання нотифікації у визначеному форматі
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
