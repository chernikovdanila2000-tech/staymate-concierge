/* ============================================================
   StayAI — сервер ШІ-адміністратора (мультитенантна, мультиканальна версія)

   Один сервер обслуговує БАГАТО готелів одночасно, кожен — з кількома
   каналами зв'язку (Telegram, Viber, віджет на сайті готелю; WhatsApp
   та Instagram підключаються пізніше, коли пройде верифікація Meta —
   див. staymate-completion-plan.md, Фаза 4).

   Роути:
     POST /chat                              — тестовий роут (потрібен propertyId в тілі)
     POST /webhook/telegram/<property_id>    — вебхук Telegram-бота готелю
     POST /webhook/viber/<property_id>       — вебхук Viber-бота готелю
     POST /webhook/website/<property_id>     — чат-віджет на сайті готелю
     POST /webhook/wayforpay                 — підтвердження оплати гостя за бронювання
     POST /webhook/wayforpay-subscription    — підтвердження оплати підписки готелю
     POST /api/create-subscription-invoice   — кабінет запитує рахунок на оплату підписки
     GET  /health

   Запуск:  node server.js
   ============================================================ */

const http = require('http');
const crypto = require('crypto');
const { runConciergeTurn } = require('./claude-client');
const { parseTelegramUpdate, sendTelegramMessage, setWebhook: setTelegramWebhook } = require('./telegram');
const { parseViberUpdate, sendViberMessage, setViberWebhook } = require('./viber');
const { safeEqual, verifyMessengerSignature, parseMessengerEvents, sendMessengerMessage } = require('./messenger');
const { serveLegalPage } = require('./legal-pages');
const { getTelegramToken, getViberToken, invalidateChannel } = require('./channels');
const { getHistory, saveHistory } = require('./conversations');
const { createSubscriptionInvoice } = require('./tools');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const WFP_MERCHANT_SECRET = process.env.WAYFORPAY_MERCHANT_SECRET || 'flk3409refn54t54t*FNJRET';
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const META_MESSENGER_PAGE_ACCESS_TOKEN = process.env.META_MESSENGER_PAGE_ACCESS_TOKEN || '';
const META_MESSENGER_APP_SECRET = process.env.META_MESSENGER_APP_SECRET || '';
const META_MESSENGER_VERIFY_TOKEN = process.env.META_MESSENGER_VERIFY_TOKEN || '';
const META_MESSENGER_PAGE_ID = process.env.META_MESSENGER_PAGE_ID || '';
const META_MESSENGER_PROPERTY_ID = process.env.META_MESSENGER_PROPERTY_ID || '';
const PROPERTY_ID = process.env.PROPERTY_ID || '';
const META_MESSENGER_PAGE_TO_PROPERTY_MAP = process.env.META_MESSENGER_PAGE_TO_PROPERTY_MAP || '';
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v24.0';

const PORT = process.env.PORT || 3000;

// Проста кеш-пам'ять даних готелю на 60 секунд, щоб не бити Supabase
// на кожне повідомлення від активного гостя.
const propertyCache = new Map(); // property_id -> { data, expiresAt }
const PROPERTY_CACHE_TTL_MS = 60 * 1000;
let fallbackPropertyId;
const invalidPropertyCache = new Map(); // property_id -> number (until timestamp)
const MESSENGER_INVALID_PROPERTY_TTL_MS = 5 * 60 * 1000;

let parsedMetaPagePropertyMap = {};
try {
  if (META_MESSENGER_PAGE_TO_PROPERTY_MAP) {
    const parsedMap = JSON.parse(META_MESSENGER_PAGE_TO_PROPERTY_MAP);
    if (parsedMap && typeof parsedMap === 'object' && !Array.isArray(parsedMap)) {
      parsedMetaPagePropertyMap = Object.fromEntries(
        Object.entries(parsedMap).map(([pageId, propertyId]) => [String(pageId), String(propertyId)])
      );
    }
  }
} catch (error) {
  console.error('[messenger] Failed to parse META_MESSENGER_PAGE_TO_PROPERTY_MAP JSON:', error.message);
}

async function resolveMessengerPropertyId(entryPageId) {
  const candidates = [];
  const addCandidate = (source, propertyId) => {
    if (!propertyId) return;
    const id = String(propertyId).trim();
    if (!id) return;
    if (!candidates.some(item => item.propertyId === id)) {
      candidates.push({ source, propertyId: id });
    }
  };

  if (entryPageId && parsedMetaPagePropertyMap[String(entryPageId)]) {
    addCandidate(`page:${entryPageId}`, parsedMetaPagePropertyMap[String(entryPageId)]);
  }
  if (META_MESSENGER_PROPERTY_ID) {
    addCandidate('env META_MESSENGER_PROPERTY_ID', META_MESSENGER_PROPERTY_ID);
  }
  if (PROPERTY_ID) {
    addCandidate('env PROPERTY_ID', PROPERTY_ID);
  }
  if (candidates.length === 0 && parsedMetaPagePropertyMap && Object.keys(parsedMetaPagePropertyMap).length > 0 && !entryPageId) {
    for (const [mappedPageId, mappedPropertyId] of Object.entries(parsedMetaPagePropertyMap)) {
      addCandidate(`map:${mappedPageId}`, mappedPropertyId);
    }
  }

  for (const candidate of candidates) {
    const { propertyId, source } = candidate;
    const cacheEntry = invalidPropertyCache.get(propertyId);
    if (cacheEntry && cacheEntry > Date.now()) {
      continue;
    }

    const exists = await getProperty(propertyId);
    if (exists) return propertyId;

    invalidPropertyCache.set(propertyId, Date.now() + MESSENGER_INVALID_PROPERTY_TTL_MS);
    console.error(
      `[messenger] Configured property not found for candidate="${propertyId}" from ${source}. ` +
      `It will be retried after cache expiry.`
    );
  }

  if (fallbackPropertyId && !(await getProperty(fallbackPropertyId))) {
    invalidPropertyCache.set(fallbackPropertyId, Date.now() + MESSENGER_INVALID_PROPERTY_TTL_MS);
    fallbackPropertyId = '';
  }
  if (fallbackPropertyId) return fallbackPropertyId;

  const fallbackAll = await supabase
    .from('properties')
    .select('property_id')
    .order('created_at', { ascending: true })
    .limit(2);
  if (!fallbackAll.error && Array.isArray(fallbackAll.data) && fallbackAll.data.length === 1) {
    fallbackPropertyId = String(fallbackAll.data[0].propertyId || fallbackAll.data[0].property_id);
    if (fallbackPropertyId) {
      console.log('[messenger] Auto-chosen single property from DB fallback:', fallbackPropertyId);
      return fallbackPropertyId;
    }
  }
  if (!fallbackAll.error && Array.isArray(fallbackAll.data)) {
    const listed = fallbackAll.data.map((row) => row.property_id).filter(Boolean);
    if (listed.length > 0 && !fallbackPropertyId) {
      const candidate = listed[0];
      fallbackPropertyId = candidate;
      console.warn('[messenger] Configured property candidates are invalid. ' +
        `Auto-selected first available property for runtime fallback: ${candidate}`);
      return candidate;
    }
    console.error(`[messenger] Missing property resolution. Configured candidates were invalid. Available properties=${JSON.stringify(listed)}.`);
  }

  return '';
}

async function getProperty(propertyId) {
  const cached = propertyCache.get(propertyId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const { data, error } = await supabase
    .from('properties')
    .select('property_id, hotel_name, telegram_bot_token, subscription_status, trial_ends_at, subscription_active_until')
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

// Той самий гейтинг, що й у кабінеті (Фаза 2.3): пробний період 3 дні з
// моменту створення профілю, далі — тільки активна оплачена підписка.
// Кабінет сам блокує СВОЮ панель керування після закінчення тріалу, але
// без цієї перевірки тут бот у Telegram/Viber/на сайті продовжував би
// відповідати гостям НЕЗАЛЕЖНО від того, платить готель чи ні.
function computeAccess(property) {
  const now = new Date();
  if (property.subscription_status === 'active') {
    if (!property.subscription_active_until || new Date(property.subscription_active_until) > now) {
      return { allowed: true };
    }
    return { allowed: false };
  }
  if (property.trial_ends_at && new Date(property.trial_ends_at) > now) {
    return { allowed: true };
  }
  return { allowed: false };
}

const PAUSED_MESSAGE =
  'Вибачте, наразі цей чат тимчасово недоступний. Будь ласка, зверніться до готелю напряму або спробуйте пізніше.';

function sendJson(res, status, payload, extraHeaders) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders));
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function wfpAcceptResponse(orderReference) {
  const time = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('md5', WFP_MERCHANT_SECRET)
    .update(`${orderReference};accept;${time}`)
    .digest('hex');
  return { orderReference, status: 'accept', time, signature };
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');

  // Public policy pages required by Meta App Review.
  if (req.method === 'GET' && serveLegalPage(requestUrl.pathname, res)) return;

  // GET/POST /webhook/messenger — Meta Messenger webhook.
  if (requestUrl.pathname === '/webhook/messenger' && req.method === 'GET') {
    const mode = requestUrl.searchParams.get('hub.mode');
    const token = requestUrl.searchParams.get('hub.verify_token');
    const challenge = requestUrl.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && challenge && safeEqual(token, META_MESSENGER_VERIFY_TOKEN)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(challenge);
    }
    return sendJson(res, 403, { error: 'Webhook verification failed.' });
  }

  if (requestUrl.pathname === '/webhook/messenger' && req.method === 'POST') {
    readBody(req).then(rawBody => {
      if (!verifyMessengerSignature(rawBody, req.headers['x-hub-signature-256'], META_MESSENGER_APP_SECRET)) {
        return sendJson(res, 401, { error: 'Invalid webhook signature.' });
      }
      let payload;
      try {
        payload = JSON.parse(rawBody || '{}');
      } catch (error) {
        return sendJson(res, 400, { error: 'Invalid JSON.' });
      }
      const events = parseMessengerEvents(payload, META_MESSENGER_PAGE_ID);
      sendJson(res, 200, { ok: true });

      setImmediate(async () => {
        if (!META_MESSENGER_PAGE_ACCESS_TOKEN) {
          console.error('[messenger] META_MESSENGER_PAGE_ACCESS_TOKEN is not configured.');
          return;
        }
        const entryPageId = Array.isArray(payload.entry) && payload.entry[0] ? payload.entry[0].id : '';
        const propertyId = await resolveMessengerPropertyId(entryPageId);
        if (!propertyId) {
          console.error(
            `[messenger] Missing property id mapping for page_id=${entryPageId || 'unknown'}. ` +
            'Set META_MESSENGER_PROPERTY_ID or META_MESSENGER_PAGE_TO_PROPERTY_MAP[page_id].'
          );
          return;
        }
        const property = await getProperty(propertyId);
        if (!property) {
          console.error(
            `[messenger] Configured property was not found. ` +
              `Query=properties where property_id="${propertyId}" (page_id=${entryPageId || 'unknown'}).`
          );
          return;
        }
        for (const event of events) {
          try {
            const history = await getHistory(propertyId, 'messenger', event.senderId);
            history.push({ role: 'user', content: event.text });
            const { replyText, updatedHistory } = await runConciergeTurn(history, {
              propertyId,
              propertyName: property.hotel_name,
            });
            await saveHistory(propertyId, 'messenger', event.senderId, updatedHistory);
            await sendMessengerMessage(META_MESSENGER_PAGE_ACCESS_TOKEN, event.senderId, replyText, META_GRAPH_VERSION);
          } catch (error) {
            console.error('[messenger] Failed to process event:', error.message);
          }
        }
      });
    }).catch(error => sendJson(res, 500, { error: error.message }));
    return;
  }

  // CORS preflight для віджета сайту (він може викликатись з домену готелю).
  if (req.method === 'OPTIONS' && req.url.startsWith('/webhook/website/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  if (req.method === 'OPTIONS' && (req.url === '/api/create-subscription-invoice' || req.url === '/api/connect-channel')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // POST /chat — тестовий роут без месенджера, для перевірки "мозку" напряму.
  if (req.method === 'POST' && req.url === '/chat') {
    readBody(req).then(async body => {
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
      if (!computeAccess(property).allowed) {
        return sendJson(res, 200, { reply: PAUSED_MESSAGE });
      }

      const history = await getHistory(propertyId, 'test', userId);
      history.push({ role: 'user', content: message });

      try {
        const { replyText, updatedHistory } = await runConciergeTurn(history, {
          propertyId,
          propertyName: property.hotel_name,
        });
        await saveHistory(propertyId, 'test', userId, updatedHistory);
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

    readBody(req).then(async body => {
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
      if (!property) {
        console.error(`Telegram webhook: готель "${propertyId}" не знайдено.`);
        return;
      }
      const botToken = await getTelegramToken(propertyId, property);
      if (!botToken) {
        console.error(`Telegram webhook: у готелю "${propertyId}" не підключено бота.`);
        return;
      }

      const { chatId, text } = parsed;

      if (!computeAccess(property).allowed) {
        try {
          await sendTelegramMessage(botToken, chatId, PAUSED_MESSAGE);
        } catch (e2) {
          console.error('Не вдалося надіслати повідомлення про паузу в Telegram:', e2);
        }
        return;
      }

      const history = await getHistory(propertyId, 'telegram', chatId);
      history.push({ role: 'user', content: text });

      try {
        const { replyText, updatedHistory } = await runConciergeTurn(history, {
          propertyId,
          propertyName: property.hotel_name,
        });
        await saveHistory(propertyId, 'telegram', chatId, updatedHistory);
        await sendTelegramMessage(botToken, chatId, replyText);
      } catch (err) {
        console.error(`Concierge error (telegram, ${propertyId}):`, err);
        try {
          await sendTelegramMessage(
            botToken,
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

  // POST /webhook/viber/<property_id> — вебхук Viber-бота готелю.
  if (req.method === 'POST' && req.url.startsWith('/webhook/viber/')) {
    const propertyId = decodeURIComponent(req.url.slice('/webhook/viber/'.length));

    readBody(req).then(async body => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');

      let update;
      try {
        update = JSON.parse(body || '{}');
      } catch (e) {
        console.error('Viber webhook: невалідний JSON');
        return;
      }

      // Службові події (перевірка вебхука, підписка тощо) — ігноруємо.
      if (update.event !== 'message') return;

      const parsed = parseViberUpdate(update);
      if (!parsed) return;

      const property = await getProperty(propertyId);
      if (!property) {
        console.error(`Viber webhook: готель "${propertyId}" не знайдено.`);
        return;
      }
      const viberToken = await getViberToken(propertyId);
      if (!viberToken) {
        console.error(`Viber webhook: у готелю "${propertyId}" не підключено Viber-бота.`);
        return;
      }

      const { chatId, text } = parsed;

      if (!computeAccess(property).allowed) {
        try {
          await sendViberMessage(viberToken, chatId, PAUSED_MESSAGE, property.hotel_name);
        } catch (e2) {
          console.error('Не вдалося надіслати повідомлення про паузу в Viber:', e2);
        }
        return;
      }

      const history = await getHistory(propertyId, 'viber', chatId);
      history.push({ role: 'user', content: text });

      try {
        const { replyText, updatedHistory } = await runConciergeTurn(history, {
          propertyId,
          propertyName: property.hotel_name,
        });
        await saveHistory(propertyId, 'viber', chatId, updatedHistory);
        await sendViberMessage(viberToken, chatId, replyText, property.hotel_name);
      } catch (err) {
        console.error(`Concierge error (viber, ${propertyId}):`, err);
      }
    });
    return;
  }

  // POST /webhook/website/<property_id> — чат-віджет, вбудований на сайт готелю.
  if (req.method === 'POST' && req.url.startsWith('/webhook/website/')) {
    const propertyId = decodeURIComponent(req.url.slice('/webhook/website/'.length));
    const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

    readBody(req).then(async body => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch (e) {
        return sendJson(res, 400, { error: 'Некоректний JSON у тілі запиту.' }, corsHeaders);
      }

      const { sessionId, message } = parsed;
      if (!sessionId || !message) {
        return sendJson(res, 400, { error: 'Потрібні поля sessionId і message.' }, corsHeaders);
      }
      if (String(message).length > 2000) {
        return sendJson(res, 400, { error: 'Повідомлення занадто довге.' }, corsHeaders);
      }

      const property = await getProperty(propertyId);
      if (!property) {
        return sendJson(res, 404, { error: 'Готель з таким ідентифікатором не знайдено.' }, corsHeaders);
      }
      if (!computeAccess(property).allowed) {
        return sendJson(res, 200, { reply: PAUSED_MESSAGE }, corsHeaders);
      }

      const history = await getHistory(propertyId, 'website', sessionId);
      history.push({ role: 'user', content: String(message) });

      try {
        const { replyText, updatedHistory } = await runConciergeTurn(history, {
          propertyId,
          propertyName: property.hotel_name,
        });
        await saveHistory(propertyId, 'website', sessionId, updatedHistory);
        return sendJson(res, 200, { reply: replyText }, corsHeaders);
      } catch (err) {
        console.error(`Concierge error (website, ${propertyId}):`, err);
        return sendJson(res, 500, { error: 'Помилка ШІ-адміністратора. Спробуйте ще раз трохи пізніше.' }, corsHeaders);
      }
    });
    return;
  }

  // POST /webhook/wayforpay — підтвердження оплати ГОСТЯ за бронювання.
  if (req.method === 'POST' && req.url === '/webhook/wayforpay') {
    readBody(req).then(async rawBody => {
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (err) {
        console.error('WayForPay webhook: невалідний JSON —', err.message);
        res.writeHead(400);
        return res.end();
      }

      const { orderReference, transactionStatus } = payload;
      console.log(`WayForPay webhook (booking): ${orderReference} → ${transactionStatus}`);

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

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(wfpAcceptResponse(orderReference)));
    });
    return;
  }

  // POST /webhook/wayforpay-subscription — підтвердження оплати ПІДПИСКИ готелю (Фаза 2).
  if (req.method === 'POST' && req.url === '/webhook/wayforpay-subscription') {
    readBody(req).then(async rawBody => {
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (err) {
        console.error('WayForPay webhook (subscription): невалідний JSON —', err.message);
        res.writeHead(400);
        return res.end();
      }

      const { orderReference, transactionStatus } = payload;
      console.log(`WayForPay webhook (subscription): ${orderReference} → ${transactionStatus}`);

      if (orderReference && transactionStatus === 'Approved') {
        const { data: order, error: orderError } = await supabase
          .from('subscription_orders')
          .select('property_id, plan')
          .eq('order_id', orderReference)
          .maybeSingle();

        if (orderError) {
          console.error('WayForPay webhook (subscription): помилка пошуку замовлення', orderError);
        } else if (order) {
          const activeUntil = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
          await supabase.from('subscription_orders').update({ status: 'paid' }).eq('order_id', orderReference);
          const { error: propError } = await supabase
            .from('properties')
            .update({
              subscription_status: 'active',
              subscription_plan: order.plan,
              subscription_active_until: activeUntil,
            })
            .eq('property_id', order.property_id);
          if (propError) {
            console.error('WayForPay webhook (subscription): не вдалося оновити properties', propError);
          } else {
            propertyCache.delete(order.property_id);
            console.log(`WayForPay webhook (subscription): підписку "${order.property_id}" активовано ✅`);
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(wfpAcceptResponse(orderReference)));
    });
    return;
  }

  // POST /api/create-subscription-invoice — кабінет запитує рахунок на оплату підписки.
  if (req.method === 'POST' && req.url === '/api/create-subscription-invoice') {
    const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
    readBody(req).then(async body => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch (e) {
        return sendJson(res, 400, { error: 'Некоректний JSON у тілі запиту.' }, corsHeaders);
      }

      const { propertyId, plan } = parsed;
      if (!propertyId || !plan) {
        return sendJson(res, 400, { error: 'Потрібні поля propertyId і plan.' }, corsHeaders);
      }

      const property = await getProperty(propertyId);
      if (!property) {
        return sendJson(res, 404, { error: 'Готель не знайдено.' }, corsHeaders);
      }

      const orderId = 'SUB' + Math.random().toString(36).slice(2, 8).toUpperCase();

      let invoiceUrl, priceEur;
      try {
        ({ invoiceUrl, priceEur } = await createSubscriptionInvoice({
          orderId,
          plan,
          propertyName: property.hotel_name,
        }));
      } catch (e) {
        console.error('[create-subscription-invoice] WayForPay error:', e.message);
        return sendJson(res, 500, { error: 'Не вдалося створити рахунок на оплату: ' + e.message }, corsHeaders);
      }

      const { error: insertError } = await supabase
        .from('subscription_orders')
        .insert({ order_id: orderId, property_id: propertyId, plan, status: 'pending', amount_eur: priceEur });

      if (insertError) {
        console.error('[create-subscription-invoice] Supabase error:', insertError);
        return sendJson(res, 500, { error: 'Не вдалося створити замовлення.' }, corsHeaders);
      }

      return sendJson(res, 200, { invoiceUrl, orderId, priceEur }, corsHeaders);
    });
    return;
  }

  // POST /api/connect-channel — кабінет підключає Telegram або Viber:
  // сервер сам реєструє вебхук у месенджера (уникаємо CORS-залежності від
  // сторонніх API з браузера) і зберігає токен у таблиці channels.
  if (req.method === 'POST' && req.url === '/api/connect-channel') {
    const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
    readBody(req).then(async body => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch (e) {
        return sendJson(res, 400, { error: 'Некоректний JSON у тілі запиту.' }, corsHeaders);
      }

      const { propertyId, channelType, credentials } = parsed;
      if (!propertyId || !channelType || !credentials || !credentials.bot_token) {
        return sendJson(res, 400, { error: 'Потрібні поля propertyId, channelType і credentials.bot_token.' }, corsHeaders);
      }
      if (channelType !== 'telegram' && channelType !== 'viber') {
        return sendJson(res, 400, { error: 'Цей канал підключається інакше (немає токена-вебхука).' }, corsHeaders);
      }

      const property = await getProperty(propertyId);
      if (!property) {
        return sendJson(res, 404, { error: 'Готель не знайдено.' }, corsHeaders);
      }

      try {
        if (channelType === 'telegram') {
          const result = await setTelegramWebhook(credentials.bot_token, `${API_BASE_URL}/webhook/telegram/${propertyId}`);
          if (!result.ok) throw new Error(result.description || 'Telegram відхилив токен.');
        } else {
          const result = await setViberWebhook(credentials.bot_token, `${API_BASE_URL}/webhook/viber/${propertyId}`);
          if (result.status !== 0) throw new Error(result.status_message || 'Viber відхилив токен.');
        }
      } catch (e) {
        return sendJson(res, 400, { error: 'Не вдалося підключити: ' + e.message }, corsHeaders);
      }

      const { error: upsertError } = await supabase
        .from('channels')
        .upsert(
          {
            property_id: propertyId,
            channel_type: channelType,
            credentials,
            connected: true,
            connected_at: new Date().toISOString(),
          },
          { onConflict: 'property_id,channel_type' }
        );

      if (upsertError) {
        console.error('[connect-channel] Supabase error:', upsertError);
        return sendJson(res, 500, { error: 'Канал підключено, але не вдалося зберегти дані. Спробуйте ще раз.' }, corsHeaders);
      }

      invalidateChannel(propertyId, channelType);
      return sendJson(res, 200, { ok: true }, corsHeaders);
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`StayAI concierge server running on http://localhost:${PORT}`);
  const mapKeys = Object.keys(parsedMetaPagePropertyMap || {});
  console.log('[messenger] Configured:', {
    pageId: META_MESSENGER_PAGE_ID || 'not_set',
    propertyId: META_MESSENGER_PROPERTY_ID || 'not_set',
    hasDirectMap: mapKeys.length > 0,
    mapCount: mapKeys.length,
  });
});
