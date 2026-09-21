const http = require('http');
const crypto = require('crypto');

const { runConciergeTurn } = require('./claude-client');
const {
  parseTelegramUpdate,
  downloadTelegramFile,
  sendTelegramMessage,
  setWebhook: setTelegramWebhook,
} = require('./telegram');
const {
  parseViberUpdate,
  sendViberMessage,
  setViberWebhook,
} = require('./viber');
const {
  safeEqual,
  verifyMessengerSignature,
  parseMessengerEvents,
  sendMessengerMessage,
} = require('./messenger');
const {
  verifyInstagramSignature,
  parseInstagramEvents,
  sendInstagramMessage,
} = require('./instagram');
const {
  verifyWhatsAppSignature,
  parseWhatsAppEvents,
  downloadWhatsAppMedia,
  sendWhatsAppMessage,
} = require('./whatsapp');
const { serveLegalPage } = require('./legal-pages');
const {
  getTelegramToken,
  getViberToken,
  invalidateChannel,
} = require('./channels');
const { getHistory, saveHistory } = require('./conversations');
const { isConversationTakenOver } = require('./takeover');
const { MAX_AUDIO_BYTES, transcribeAudio } = require('./transcription');
const {
  createSubscriptionInvoice,
  cancelRegularPayment,
} = require('./tools');
const {
  extractRoomsFromFile,
  markDuplicates,
  MAX_FILE_SIZE_BYTES: ROOMS_MAX_FILE_SIZE_BYTES,
} = require('./rooms-import');
const busboy = require('busboy');
const {
  encryptCredentials,
  decryptCredentials,
  encryptCredentialsPartial,
  decryptCredentialsPartial,
} = require('./channel-crypto');
const {
  verifyWhatsAppCredentials,
  verifyInstagramCredentials,
  verifyMessengerCredentials,
} = require('./meta-verify');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const WFP_MERCHANT_SECRET =
  process.env.WAYFORPAY_MERCHANT_SECRET ||
  'flk3409refn54t54t*FNJRET';

const API_BASE_URL =
  process.env.API_BASE_URL || 'http://localhost:3000';

const RESEND_API_KEY =
  process.env.RESEND_API_KEY || '';

const RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL ||
  'StayAI <noreply@stayai.online>';

// Бот і чат для сайтового contact-form (сторінка "Контакти") — окремий від
// ботів окремих готелів (ті зберігаються в таблиці channels per-property).
// STAYAI_SUPPORT_TELEGRAM_CHAT_ID — id чату/каналу @StayAI_support, куди
// падають звернення з сайту.
const STAYAI_SUPPORT_TELEGRAM_BOT_TOKEN =
  process.env.STAYAI_SUPPORT_TELEGRAM_BOT_TOKEN || '';

const STAYAI_SUPPORT_TELEGRAM_CHAT_ID =
  process.env.STAYAI_SUPPORT_TELEGRAM_CHAT_ID || '';

const STAYAI_SUPPORT_EMAIL =
  process.env.STAYAI_SUPPORT_EMAIL || 'stayaiproject@gmail.com';

const META_MESSENGER_PAGE_ACCESS_TOKEN =
  process.env.META_MESSENGER_PAGE_ACCESS_TOKEN || '';

const META_MESSENGER_APP_SECRET =
  process.env.META_MESSENGER_APP_SECRET || '';

const META_MESSENGER_VERIFY_TOKEN =
  process.env.META_MESSENGER_VERIFY_TOKEN || '';

const META_MESSENGER_PAGE_ID =
  process.env.META_MESSENGER_PAGE_ID || '';

const META_MESSENGER_PROPERTY_ID =
  process.env.META_MESSENGER_PROPERTY_ID || '';

const META_MESSENGER_PAGE_TO_PROPERTY_MAP =
  process.env.META_MESSENGER_PAGE_TO_PROPERTY_MAP || '';

const META_GRAPH_VERSION =
  process.env.META_GRAPH_VERSION || 'v24.0';

const PROPERTY_ID =
  process.env.PROPERTY_ID || '';

const META_INSTAGRAM_VERIFY_TOKEN =
  process.env.META_INSTAGRAM_VERIFY_TOKEN || '';

const META_INSTAGRAM_ACCESS_TOKEN =
  process.env.META_INSTAGRAM_ACCESS_TOKEN || '';

const META_INSTAGRAM_ACCOUNT_ID =
  process.env.META_INSTAGRAM_ACCOUNT_ID || '';

const META_INSTAGRAM_PROPERTY_ID =
  process.env.META_INSTAGRAM_PROPERTY_ID || '';

const META_WHATSAPP_VERIFY_TOKEN =
  process.env.META_WHATSAPP_VERIFY_TOKEN || '';

const META_WHATSAPP_ACCESS_TOKEN =
  process.env.META_WHATSAPP_ACCESS_TOKEN || '';

const META_WHATSAPP_PHONE_NUMBER_ID =
  process.env.META_WHATSAPP_PHONE_NUMBER_ID || '';

const META_WHATSAPP_PROPERTY_ID =
  process.env.META_WHATSAPP_PROPERTY_ID || '';

const PORT = process.env.PORT || 3000;

const propertyCache = new Map();
const PROPERTY_CACHE_TTL_MS = 60 * 1000;

const invalidPropertyCache = new Map();
const MESSENGER_INVALID_PROPERTY_TTL_MS = 5 * 60 * 1000;

let fallbackPropertyId = '';

let parsedMetaPagePropertyMap = {};

try {
  if (META_MESSENGER_PAGE_TO_PROPERTY_MAP) {
    const parsedMap =
      JSON.parse(META_MESSENGER_PAGE_TO_PROPERTY_MAP);

    if (
      parsedMap &&
      typeof parsedMap === 'object' &&
      !Array.isArray(parsedMap)
    ) {
      parsedMetaPagePropertyMap =
        Object.fromEntries(
          Object.entries(parsedMap).map(
            ([pageId, propertyId]) => [
              String(pageId),
              String(propertyId),
            ]
          )
        );
    }
  }
} catch (error) {
  console.error(
    '[messenger] Failed to parse page map:',
    error.message
  );
}

async function getProperty(propertyId) {
  const id = String(propertyId || '').trim();

  if (!id) return null;

  const cached = propertyCache.get(id);

  if (
    cached &&
    cached.expiresAt > Date.now()
  ) {
    return cached.data;
  }

  const { data, error } =
    await supabase
      .from('properties')
      .select(
        'property_id, hotel_name, telegram_bot_token, subscription_status, trial_ends_at, subscription_active_until'
      )
      .eq('property_id', id)
      .maybeSingle();

  if (error) {
    console.error(
      '[getProperty] Supabase error:',
      error
    );

    return null;
  }

  if (!data) return null;

  propertyCache.set(id, {
    data,
    expiresAt:
      Date.now() + PROPERTY_CACHE_TTL_MS,
  });

  return data;
}

// Once an employee has taken a conversation, new guest messages are still
// preserved in its history, but the AI must stay silent until that employee
// resolves the escalation in the cabinet.  A failed status lookup must not
// take a production channel down, so it is logged and the normal flow stays
// available.
async function isTakenOverConversation(propertyId, channel, chatId) {
  try {
    return await isConversationTakenOver({ supabase, propertyId, channel, chatId });
  } catch (error) {
    console.error('[takeover] status check failed:', error.message);
    return false;
  }
}

/**
 * Перевіряє, що запит несе дійсний Supabase-токен власника готелю
 * propertyId (заголовок Authorization: Bearer <jwt>), а не просто довіряє
 * propertyId із тіла запиту — інакше будь-хто, хто вгадає/підгляне чужий
 * property_id, міг би читати чи змінювати дані іншого готелю через backend
 * API (на відміну від прямих запитів кабінету до Supabase, які й так
 * захищені RLS-політиками за owner_id). Повертає рядок properties або
 * кидає Error з полем .status для однакової обробки в усіх новых роутах.
 */
async function requireOwnedProperty(req, propertyId) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    const err = new Error('Потрібна авторизація.');
    err.status = 401;
    throw err;
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    const err = new Error('Недійсна сесія — увійдіть у кабінет ще раз.');
    err.status = 401;
    throw err;
  }

  const { data: property, error: propError } = await supabase
    .from('properties')
    .select('property_id, owner_id, hotel_name')
    .eq('property_id', String(propertyId || '').trim())
    .maybeSingle();

  if (propError || !property) {
    const err = new Error('Готель не знайдено.');
    err.status = 404;
    throw err;
  }

  if (property.owner_id !== user.id) {
    const err = new Error('Немає доступу до цього готелю.');
    err.status = 403;
    throw err;
  }

  return property;
}

async function resolveMessengerPropertyId(
  entryPageId
) {
  const candidates = [];

  const addCandidate = (
    source,
    propertyId
  ) => {
    if (!propertyId) return;

    const id =
      String(propertyId).trim();

    if (!id) return;

    if (
      !candidates.some(
        item => item.propertyId === id
      )
    ) {
      candidates.push({
        source,
        propertyId: id,
      });
    }
  };

  if (
    entryPageId &&
    parsedMetaPagePropertyMap[
      String(entryPageId)
    ]
  ) {
    addCandidate(
      `page:${entryPageId}`,
      parsedMetaPagePropertyMap[
        String(entryPageId)
      ]
    );
  }

  addCandidate(
    'META_MESSENGER_PROPERTY_ID',
    META_MESSENGER_PROPERTY_ID
  );

  addCandidate(
    'PROPERTY_ID',
    PROPERTY_ID
  );

  for (const candidate of candidates) {
    const {
      propertyId,
      source,
    } = candidate;

    const invalidUntil =
      invalidPropertyCache.get(propertyId);

    if (
      invalidUntil &&
      invalidUntil > Date.now()
    ) {
      continue;
    }

    const property =
      await getProperty(propertyId);

    if (property) {
      return propertyId;
    }

    invalidPropertyCache.set(
      propertyId,
      Date.now() +
        MESSENGER_INVALID_PROPERTY_TTL_MS
    );

    console.error(
      `[messenger] Property "${propertyId}" from ${source} not found`
    );
  }

  if (
    fallbackPropertyId &&
    await getProperty(fallbackPropertyId)
  ) {
    return fallbackPropertyId;
  }

  const result =
    await supabase
      .from('properties')
      .select('property_id')
      .order('created_at', {
        ascending: true,
      })
      .limit(2);

  if (
    !result.error &&
    Array.isArray(result.data) &&
    result.data.length === 1
  ) {
    fallbackPropertyId =
      String(
        result.data[0].property_id || ''
      );

    return fallbackPropertyId;
  }

  if (
    !result.error &&
    Array.isArray(result.data) &&
    result.data.length > 0
  ) {
    fallbackPropertyId =
      String(
        result.data[0].property_id || ''
      );

    return fallbackPropertyId;
  }

  return '';
}

async function resolveInstagramConnection(
  instagramAccountId
) {
  const accountId =
    String(instagramAccountId || '').trim();

  if (!accountId) return null;

  const { data, error } =
    await supabase
      .from('channels')
      .select(
        'property_id, credentials, connected'
      )
      .eq(
        'channel_type',
        'instagram'
      )
      .eq(
        'connected',
        true
      )
      .contains(
        'credentials',
        {
          instagram_account_id:
            accountId,
        }
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    console.error(
      '[instagram] Channel lookup error:',
      error
    );
  }

  if (data && data.credentials) {
    data.credentials = decryptCredentialsPartial(data.credentials, 'access_token');
  }

  if (
    data &&
    data.credentials &&
    data.credentials.access_token
  ) {
    let propertyId =
      String(data.property_id || '').trim();

    if (
      !propertyId ||
      !(await getProperty(propertyId))
    ) {
      propertyId =
        await resolveMessengerPropertyId('');
    }

    if (!propertyId) {
      return null;
    }

    return {
      propertyId,

      accessToken:
        String(
          data.credentials.access_token
        ),

      instagramAccountId:
        accountId,
    };
  }

  if (
    META_INSTAGRAM_ACCESS_TOKEN &&
    META_INSTAGRAM_ACCOUNT_ID &&
    String(
      META_INSTAGRAM_ACCOUNT_ID
    ) === accountId
  ) {
    let propertyId =
      String(
        META_INSTAGRAM_PROPERTY_ID ||
        META_MESSENGER_PROPERTY_ID ||
        PROPERTY_ID ||
        ''
      ).trim();

    if (
      !propertyId ||
      !(await getProperty(propertyId))
    ) {
      console.log(
        '[instagram] Configured property not found, using property fallback:',
        propertyId
      );

      propertyId =
        await resolveMessengerPropertyId('');
    }

    if (!propertyId) {
      console.error(
        '[instagram] No valid property resolved'
      );

      return null;
    }

    console.log(
      '[instagram] Resolved property:',
      propertyId
    );

    return {
      propertyId,

      accessToken:
        META_INSTAGRAM_ACCESS_TOKEN,

      instagramAccountId:
        accountId,
    };
  }

  return null;
}

async function resolveWhatsAppConnection(phoneNumberId) {
  const id = String(phoneNumberId || '').trim();
  if (!id) return null;

  const { data, error } = await supabase
    .from('channels')
    .select('property_id, credentials, connected')
    .eq('channel_type', 'whatsapp')
    .eq('connected', true)
    .contains('credentials', { phone_number_id: id })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[whatsapp] Channel lookup error:', error);
  }

  if (data && data.credentials) {
    data.credentials = decryptCredentialsPartial(data.credentials, 'access_token');
  }

  if (data && data.credentials && data.credentials.access_token) {
    let propertyId = String(data.property_id || '').trim();
    if (!propertyId || !(await getProperty(propertyId))) {
      propertyId = await resolveMessengerPropertyId('');
    }
    if (!propertyId) return null;
    return {
      propertyId,
      accessToken: String(data.credentials.access_token),
      phoneNumberId: id,
    };
  }

  if (META_WHATSAPP_ACCESS_TOKEN && META_WHATSAPP_PHONE_NUMBER_ID &&
      String(META_WHATSAPP_PHONE_NUMBER_ID) === id) {
    let propertyId = String(META_WHATSAPP_PROPERTY_ID ||
      META_MESSENGER_PROPERTY_ID || PROPERTY_ID || '').trim();
    if (!propertyId || !(await getProperty(propertyId))) {
      propertyId = await resolveMessengerPropertyId('');
    }
    if (!propertyId) return null;
    return { propertyId, accessToken: META_WHATSAPP_ACCESS_TOKEN, phoneNumberId: id };
  }

  return null;
}

/**
 * Per-tenant пошук Facebook Page Access Token за page_id (Блок 4) — той
 * самий патерн, що й resolveInstagramConnection/resolveWhatsAppConnection.
 * Раніше Messenger надсилав відповіді ЛИШЕ через один спільний
 * META_MESSENGER_PAGE_ACCESS_TOKEN незалежно від того, якому готелю
 * належить сторінка — це працювало тільки для одного готелю одразу.
 */
async function resolveMessengerConnection(pageId) {
  const id = String(pageId || '').trim();
  if (!id) return null;

  const { data, error } = await supabase
    .from('channels')
    .select('property_id, credentials, connected')
    .eq('channel_type', 'messenger')
    .eq('connected', true)
    .contains('credentials', { page_id: id })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[messenger] Channel lookup error:', error);
  }

  if (data && data.credentials) {
    data.credentials = decryptCredentialsPartial(data.credentials, 'access_token');
  }

  if (data && data.credentials && data.credentials.access_token) {
    let propertyId = String(data.property_id || '').trim();
    if (!propertyId || !(await getProperty(propertyId))) {
      propertyId = await resolveMessengerPropertyId(id);
    }
    if (!propertyId) return null;
    return { propertyId, accessToken: String(data.credentials.access_token), pageId: id };
  }

  // Резерв: старий однотенантний шлях через env vars (лишається робочим,
  // поки хоча б один готель підключений тільки так).
  if (META_MESSENGER_PAGE_ACCESS_TOKEN) {
    const propertyId = await resolveMessengerPropertyId(id);
    if (!propertyId) return null;
    return { propertyId, accessToken: META_MESSENGER_PAGE_ACCESS_TOKEN, pageId: id };
  }

  return null;
}

/**
 * Надсилає повідомлення гостю назад через той самий канал, яким власник
 * готелю зайшов у розмову з кабінету (розділ "Ескалації"). На відміну від
 * resolveInstagramConnection/resolveWhatsAppConnection/resolveMessengerConnection
 * вище (які шукають властивість ЗА зовнішнім account/phone/page id — вхідний
 * вебхук), тут property_id вже відомий (власник автентифікований і працює у
 * своєму кабінеті), тому шукаємо канал напряму за property_id + channel_type.
 */
async function sendReplyThroughChannel(propertyId, channel, chatId, text) {
  if (channel === 'telegram') {
    const property = await getProperty(propertyId);
    const botToken = await getTelegramToken(propertyId, property);
    if (!botToken) throw new Error('Telegram не підключено для цього готелю.');
    return sendTelegramMessage(botToken, chatId, text);
  }

  if (channel === 'viber') {
    const botToken = await getViberToken(propertyId);
    if (!botToken) throw new Error('Viber не підключено для цього готелю.');
    return sendViberMessage(botToken, chatId, text);
  }

  if (channel === 'whatsapp') {
    const { data } = await supabase
      .from('channels')
      .select('credentials, connected')
      .eq('property_id', propertyId)
      .eq('channel_type', 'whatsapp')
      .maybeSingle();
    let accessToken = null;
    let phoneNumberId = null;
    if (data && data.connected && data.credentials) {
      const creds = decryptCredentialsPartial(data.credentials, 'access_token');
      accessToken = creds.access_token || null;
      phoneNumberId = creds.phone_number_id || null;
    }
    if (!accessToken || !phoneNumberId) {
      accessToken = META_WHATSAPP_ACCESS_TOKEN || null;
      phoneNumberId = META_WHATSAPP_PHONE_NUMBER_ID || null;
    }
    if (!accessToken || !phoneNumberId) throw new Error('WhatsApp не підключено для цього готелю.');
    return sendWhatsAppMessage(accessToken, phoneNumberId, chatId, text, META_GRAPH_VERSION);
  }

  if (channel === 'instagram') {
    const { data } = await supabase
      .from('channels')
      .select('credentials, connected')
      .eq('property_id', propertyId)
      .eq('channel_type', 'instagram')
      .maybeSingle();
    let accessToken = null;
    let instagramAccountId = null;
    if (data && data.connected && data.credentials) {
      const creds = decryptCredentialsPartial(data.credentials, 'access_token');
      accessToken = creds.access_token || null;
      instagramAccountId = creds.instagram_account_id || null;
    }
    if (!accessToken) {
      accessToken = META_INSTAGRAM_ACCESS_TOKEN || null;
      instagramAccountId = META_INSTAGRAM_ACCOUNT_ID || null;
    }
    if (!accessToken) throw new Error('Instagram не підключено для цього готелю.');
    return sendInstagramMessage(accessToken, instagramAccountId, chatId, text, META_GRAPH_VERSION);
  }

  if (channel === 'messenger') {
    const { data } = await supabase
      .from('channels')
      .select('credentials, connected')
      .eq('property_id', propertyId)
      .eq('channel_type', 'messenger')
      .maybeSingle();
    let accessToken = null;
    if (data && data.connected && data.credentials) {
      const creds = decryptCredentialsPartial(data.credentials, 'access_token');
      accessToken = creds.access_token || null;
    }
    if (!accessToken) {
      accessToken = META_MESSENGER_PAGE_ACCESS_TOKEN || null;
    }
    if (!accessToken) throw new Error('Messenger не підключено для цього готелю.');
    return sendMessengerMessage(accessToken, chatId, text, META_GRAPH_VERSION);
  }

  if (channel === 'website') {
    // Немає push-API до гостя (лише HTTP-запит/відповідь) — "надсилання"
    // тут означає лише дописати повідомлення в conversations (робить
    // виклик нижче, у /api/escalations/reply). Віджет сам підхоплює нове
    // повідомлення через періодичний GET /api/website-chat/:propertyId/:sessionId,
    // поки в гостя відкрита вкладка з сайтом готелю.
    return { ok: true };
  }

  if (channel === 'test') {
    // Внутрішній dev-чат (/chat) — немає жодного віджету чи клієнта, який
    // міг би підхопити відповідь пізніше.
    throw new Error('Цей канал не підтримує відповідь із кабінету.');
  }

  throw new Error('Невідомий канал: ' + channel);
}

function computeAccess(property) {
  const now = new Date();

  if (
    property.subscription_status ===
    'active'
  ) {
    if (
      !property.subscription_active_until ||
      new Date(
        property.subscription_active_until
      ) > now
    ) {
      return {
        allowed: true,
      };
    }

    return {
      allowed: false,
    };
  }

  if (
    property.trial_ends_at &&
    new Date(
      property.trial_ends_at
    ) > now
  ) {
    return {
      allowed: true,
    };
  }

  return {
    allowed: false,
  };
}

const PAUSED_MESSAGE =
  'Вибачте, наразі цей чат тимчасово недоступний. Будь ласка, зверніться до готелю напряму або спробуйте пізніше.';

function sendJson(
  res,
  status,
  payload,
  extraHeaders
) {
  res.writeHead(
    status,
    Object.assign(
      {
        'Content-Type':
          'application/json; charset=utf-8',
      },
      extraHeaders || {}
    )
  );

  res.end(
    JSON.stringify(payload)
  );
}

function readBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = '';

      req.on(
        'data',
        chunk => {
          body += chunk;
        }
      );

      req.on(
        'end',
        () => resolve(body)
      );

      req.on(
        'error',
        reject
      );
    }
  );
}

async function sendSignInNotification(
  email
) {
  if (
    !RESEND_API_KEY ||
    !email
  ) {
    return;
  }

  const html = `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#17181b">
  <h2>StayAI</h2>
  <h3>Новий вхід в акаунт</h3>
  <p>Хтось щойно увійшов у ваш акаунт StayAI (${email}).</p>
  <p>Якщо це були ви — нічого робити не потрібно. Якщо ні — негайно змініть пароль.</p>
</div>`;

  try {
    const response =
      await fetch(
        'https://api.resend.com/emails',
        {
          method: 'POST',

          headers: {
            Authorization:
              `Bearer ${RESEND_API_KEY}`,

            'Content-Type':
              'application/json',
          },

          body:
            JSON.stringify({
              from:
                RESEND_FROM_EMAIL,

              to: [email],

              subject:
                'Новий вхід в акаунт — StayAI',

              html,
            }),
        }
      );

    if (!response.ok) {
      console.error(
        '[signin-email]',
        response.status,
        await response.text()
      );
    }
  } catch (error) {
    console.error(
      '[signin-email]',
      error.message
    );
  }
}

// Звернення з форми на сторінці "Контакти" сайту — надсилаємо в Telegram
// @StayAI_support (основний канал, за замовчуванням) і, якщо налаштовано
// Resend, дублюємо на пошту stayaiproject@gmail.com. Обидва канали
// best-effort і незалежні один від одного: збій одного не має блокувати
// інший чи ламати відповідь для гостя, який просто хоче написати нам.
async function sendContactFormNotification(name, email, message) {
  const result = { telegramSent: false, emailSent: false };

  if (STAYAI_SUPPORT_TELEGRAM_BOT_TOKEN && STAYAI_SUPPORT_TELEGRAM_CHAT_ID) {
    try {
      const text = `📩 Нове звернення з сайту StayAI\n\nІм'я: ${name}\nEmail: ${email}\n\n${message}`;
      await sendTelegramMessage(STAYAI_SUPPORT_TELEGRAM_BOT_TOKEN, STAYAI_SUPPORT_TELEGRAM_CHAT_ID, text);
      result.telegramSent = true;
    } catch (error) {
      console.error('[contact-form][telegram]', error.message);
    }
  }

  if (RESEND_API_KEY) {
    try {
      const html = `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#17181b">
  <h2>StayAI — нове звернення з сайту</h2>
  <p><b>Ім'я:</b> ${name}</p>
  <p><b>Email:</b> ${email}</p>
  <p><b>Повідомлення:</b></p>
  <p style="white-space:pre-wrap">${message}</p>
</div>`;
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: [STAYAI_SUPPORT_EMAIL],
          reply_to: email,
          subject: `Нове звернення з сайту — ${name}`,
          html,
        }),
      });
      if (response.ok) {
        result.emailSent = true;
      } else {
        console.error('[contact-form][email]', response.status, await response.text());
      }
    } catch (error) {
      console.error('[contact-form][email]', error.message);
    }
  }

  return result;
}

function wfpAcceptResponse(
  orderReference
) {
  const time =
    Math.floor(
      Date.now() / 1000
    );

  const signature =
    crypto
      .createHmac(
        'md5',
        WFP_MERCHANT_SECRET
      )
      .update(
        `${orderReference};accept;${time}`
      )
      .digest('hex');

  return {
    orderReference,
    status: 'accept',
    time,
    signature,
  };
}

const server =
  http.createServer(
    (req, res) => {
      const requestUrl =
        new URL(
          req.url,
          'http://localhost'
        );

      if (
        req.method === 'GET' &&
        serveLegalPage(
          requestUrl.pathname,
          res
        )
      ) {
        return;
      }

      // =========================
      // MESSENGER VERIFY
      // =========================

      if (
        requestUrl.pathname ===
          '/webhook/messenger' &&
        req.method === 'GET'
      ) {
        const mode =
          requestUrl.searchParams.get(
            'hub.mode'
          );

        const token =
          requestUrl.searchParams.get(
            'hub.verify_token'
          );

        const challenge =
          requestUrl.searchParams.get(
            'hub.challenge'
          );

        if (
          mode === 'subscribe' &&
          challenge &&
          safeEqual(
            token,
            META_MESSENGER_VERIFY_TOKEN
          )
        ) {
          res.writeHead(
            200,
            {
              'Content-Type':
                'text/plain; charset=utf-8',
            }
          );

          return res.end(
            challenge
          );
        }

        return sendJson(
          res,
          403,
          {
            error:
              'Webhook verification failed.',
          }
        );
      }

      // =========================
      // MESSENGER MESSAGE
      // =========================

      if (
        requestUrl.pathname ===
          '/webhook/messenger' &&
        req.method === 'POST'
      ) {
        readBody(req)
          .then(rawBody => {
            if (
              !verifyMessengerSignature(
                rawBody,
                req.headers[
                  'x-hub-signature-256'
                ],
                META_MESSENGER_APP_SECRET
              )
            ) {
              return sendJson(
                res,
                401,
                {
                  error:
                    'Invalid webhook signature.',
                }
              );
            }

            let payload;

            try {
              payload =
                JSON.parse(
                  rawBody || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Invalid JSON.',
                }
              );
            }

            // Без expectedPageId — payload може містити повідомлення для
            // кількох готелів одразу (кожен зі своєю Facebook-сторінкою),
            // тому кожна подія несе власний pageId і роутиться окремо
            // нижче через resolveMessengerConnection (Блок 4: multi-tenant).
            const events =
              parseMessengerEvents(payload);

            sendJson(
              res,
              200,
              {
                ok: true,
              }
            );

            setImmediate(
              async () => {
                for (
                  const event of events
                ) {
                  try {
                    const connection =
                      await resolveMessengerConnection(
                        event.pageId
                      );

                    if (!connection) {
                      console.error(
                        '[messenger] No channel connected for page',
                        event.pageId
                      );
                      continue;
                    }

                    const property =
                      await getProperty(
                        connection.propertyId
                      );

                    if (!property) continue;

                    const history =
                      await getHistory(
                        connection.propertyId,
                        'messenger',
                        event.senderId
                      );

                    history.push({
                      role: 'user',
                      content:
                        event.text,
                    });

                    if (await isTakenOverConversation(connection.propertyId, 'messenger', event.senderId)) {
                      await saveHistory(connection.propertyId, 'messenger', event.senderId, history);
                      continue;
                    }

                    const {
                      replyText,
                      updatedHistory,
                    } =
                      await runConciergeTurn(
                        history,
                        {
                          propertyId: connection.propertyId,
                          propertyName:
                            property.hotel_name,
                          channel: 'messenger',
                          chatId: event.senderId,
                        }
                      );

                    await saveHistory(
                      connection.propertyId,
                      'messenger',
                      event.senderId,
                      updatedHistory
                    );

                    await sendMessengerMessage(
                      connection.accessToken,
                      event.senderId,
                      replyText,
                      META_GRAPH_VERSION
                    );
                  } catch (error) {
                    console.error(
                      '[messenger]',
                      error.message
                    );
                  }
                }
              }
            );
          })
          .catch(
            error =>
              sendJson(
                res,
                500,
                {
                  error:
                    error.message,
                }
              )
          );

        return;
      }

      // =========================
      // INSTAGRAM VERIFY
      // =========================

      if (
        requestUrl.pathname ===
          '/webhook/instagram' &&
        req.method === 'GET'
      ) {
        const mode =
          requestUrl.searchParams.get(
            'hub.mode'
          );

        const token =
          requestUrl.searchParams.get(
            'hub.verify_token'
          );

        const challenge =
          requestUrl.searchParams.get(
            'hub.challenge'
          );

        if (
          mode === 'subscribe' &&
          challenge &&
          safeEqual(
            token,
            META_INSTAGRAM_VERIFY_TOKEN
          )
        ) {
          res.writeHead(
            200,
            {
              'Content-Type':
                'text/plain; charset=utf-8',
            }
          );

          return res.end(
            challenge
          );
        }

        return sendJson(
          res,
          403,
          {
            error:
              'Instagram webhook verification failed.',
          }
        );
      }

      // =========================
      // INSTAGRAM MESSAGE
      // =========================

      if (
        requestUrl.pathname ===
          '/webhook/instagram' &&
        req.method === 'POST'
      ) {
        readBody(req)
          .then(rawBody => {
            if (
              !verifyInstagramSignature(
                rawBody,
                req.headers[
                  'x-hub-signature-256'
                ],
                META_MESSENGER_APP_SECRET
              )
            ) {
              return sendJson(
                res,
                401,
                {
                  error:
                    'Invalid Instagram signature.',
                }
              );
            }

            let payload;

            try {
              payload =
                JSON.parse(
                  rawBody || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Invalid JSON.',
                }
              );
            }

            console.log(
              '[instagram] PAYLOAD:',
              rawBody
            );

            const events =
              parseInstagramEvents(
                payload
              );

            const accountId =
              Array.isArray(
                payload.entry
              ) &&
              payload.entry[0]
                ? String(
                    payload.entry[0]
                      .id || ''
                  )
                : '';

            console.log(
              '[instagram] PARSED:',
              {
                accountId,
                eventsCount:
                  events.length,
                events,
              }
            );

            sendJson(
              res,
              200,
              {
                ok: true,
              }
            );

            if (
              !accountId ||
              events.length === 0
            ) {
              console.error(
                '[instagram] Nothing to process:',
                {
                  accountId,
                  eventsCount:
                    events.length,
                }
              );

              return;
            }

            setImmediate(
              async () => {
                try {
                  console.log(
                    '[instagram] BEFORE CONNECTION'
                  );

                  const connection =
                    await resolveInstagramConnection(
                      accountId
                    );

                  console.log(
                    '[instagram] CONNECTION:',
                    {
                      found:
                        !!connection,

                      propertyId:
                        connection
                          ? connection.propertyId
                          : null,

                      instagramAccountId:
                        connection
                          ? connection.instagramAccountId
                          : null,
                    }
                  );

                  if (!connection) {
                    console.error(
                      `[instagram] No channel for ${accountId}`
                    );

                    return;
                  }

                  console.log(
                    '[instagram] BEFORE PROPERTY:',
                    connection.propertyId
                  );

                  const property =
                    await getProperty(
                      connection.propertyId
                    );

                  console.log(
                    '[instagram] PROPERTY:',
                    {
                      found:
                        !!property,

                      hotelName:
                        property
                          ? property.hotel_name
                          : null,

                      subscriptionStatus:
                        property
                          ? property.subscription_status
                          : null,

                      trialEndsAt:
                        property
                          ? property.trial_ends_at
                          : null,

                      subscriptionActiveUntil:
                        property
                          ? property.subscription_active_until
                          : null,
                    }
                  );

                  if (!property) {
                    console.error(
                      '[instagram] Property not found:',
                      connection.propertyId
                    );

                    return;
                  }

                  const access =
                    computeAccess(
                      property
                    );

                  console.log(
                    '[instagram] ACCESS:',
                    access
                  );

                  for (
                    const event of events
                  ) {
                    try {
                      console.log(
                        '[instagram] EVENT START:',
                        {
                          senderId:
                            event.senderId,

                          text:
                            event.text,
                        }
                      );

                      if (
                        !access.allowed
                      ) {
                        console.log(
                          '[instagram] BEFORE PAUSED SEND'
                        );

                        await sendInstagramMessage(
                          connection.accessToken,
                          connection.instagramAccountId,
                          event.senderId,
                          PAUSED_MESSAGE,
                          META_GRAPH_VERSION
                        );

                        console.log(
                          '[instagram] AFTER PAUSED SEND'
                        );

                        continue;
                      }

                      console.log(
                        '[instagram] BEFORE HISTORY'
                      );

                      const history =
                        await getHistory(
                          connection.propertyId,
                          'instagram',
                          event.senderId
                        );

                      console.log(
                        '[instagram] HISTORY LOADED:',
                        {
                          length:
                            Array.isArray(
                              history
                            )
                              ? history.length
                              : null,
                        }
                      );

                      history.push({
                        role: 'user',
                        content:
                          event.text,
                      });

                      if (await isTakenOverConversation(connection.propertyId, 'instagram', event.senderId)) {
                        await saveHistory(connection.propertyId, 'instagram', event.senderId, history);
                        continue;
                      }

                      console.log(
                        '[instagram] BEFORE AI'
                      );

                      const {
                        replyText,
                        updatedHistory,
                      } =
                        await runConciergeTurn(
                          history,
                          {
                            propertyId:
                              connection.propertyId,

                            propertyName:
                              property.hotel_name,

                            channel:
                              'instagram',

                            chatId:
                              event.senderId,
                          }
                        );

                      console.log(
                        '[instagram] AFTER AI:',
                        {
                          replyLength:
                            String(
                              replyText || ''
                            ).length,

                          historyLength:
                            Array.isArray(
                              updatedHistory
                            )
                              ? updatedHistory.length
                              : null,
                        }
                      );

                      console.log(
                        '[instagram] BEFORE SAVE HISTORY'
                      );

                      await saveHistory(
                        connection.propertyId,
                        'instagram',
                        event.senderId,
                        updatedHistory
                      );

                      console.log(
                        '[instagram] AFTER SAVE HISTORY'
                      );

                      console.log(
                        '[instagram] BEFORE SEND'
                      );

                      await sendInstagramMessage(
                        connection.accessToken,
                        connection.instagramAccountId,
                        event.senderId,
                        replyText,
                        META_GRAPH_VERSION
                      );

                      console.log(
                        '[instagram] AFTER SEND'
                      );
                    } catch (
                      error
                    ) {
                      console.error(
                        '[instagram] EVENT ERROR:',
                        error &&
                        error.stack
                          ? error.stack
                          : error
                      );
                    }
                  }
                } catch (error) {
                  console.error(
                    '[instagram] PROCESS ERROR:',
                    error &&
                    error.stack
                      ? error.stack
                      : error
                  );
                }
              }
            );
          })
          .catch(
            error => {
              console.error(
                '[instagram] WEBHOOK ERROR:',
                error &&
                error.stack
                  ? error.stack
                  : error
              );

              return sendJson(
                res,
                500,
                {
                  error:
                    error.message,
                }
              );
            }
          );

        return;
      }

      // =========================
      // WHATSAPP VERIFY
      // =========================

      if (
        requestUrl.pathname === '/webhook/whatsapp' &&
        req.method === 'GET'
      ) {
        const mode = requestUrl.searchParams.get('hub.mode');
        const token = requestUrl.searchParams.get('hub.verify_token');
        const challenge = requestUrl.searchParams.get('hub.challenge');

        if (mode === 'subscribe' && challenge &&
            META_WHATSAPP_VERIFY_TOKEN &&
            safeEqual(token, META_WHATSAPP_VERIFY_TOKEN)) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(challenge);
        }

        return sendJson(res, 403, { error: 'WhatsApp webhook verification failed.' });
      }

      // =========================
      // WHATSAPP MESSAGE
      // =========================
      if (
        requestUrl.pathname === '/webhook/whatsapp' &&
        req.method === 'POST'
      ) {
        readBody(req).then(rawBody => {
          if (!verifyWhatsAppSignature(
            rawBody,
            req.headers['x-hub-signature-256'],
            META_MESSENGER_APP_SECRET
          )) {
            return sendJson(res, 401, { error: 'Invalid WhatsApp signature.' });
          }

          let payload;
          try {
            payload = JSON.parse(rawBody || '{}');
          } catch {
            return sendJson(res, 400, { error: 'Invalid JSON.' });
          }

          const events = parseWhatsAppEvents(payload);
          sendJson(res, 200, { ok: true });
          if (events.length === 0) return;

          setImmediate(async () => {
            for (const event of events) {
              try {
                const connection = await resolveWhatsAppConnection(event.phoneNumberId);
                if (!connection) {
                  console.error('[whatsapp] No channel for phone number id');
                  continue;
                }
                const property = await getProperty(connection.propertyId);
                if (!property) {
                  console.error('[whatsapp] Property not found');
                  continue;
                }

                const access = computeAccess(property);
                if (!access.allowed) {
                  await sendWhatsAppMessage(
                    connection.accessToken,
                    connection.phoneNumberId,
                    event.senderId,
                    PAUSED_MESSAGE,
                    META_GRAPH_VERSION
                  );
                  continue;
                }

                let incomingText = event.text;
                if (event.audio) {
                  const media = await downloadWhatsAppMedia(
                    connection.accessToken,
                    event.audio.mediaId,
                    connection.phoneNumberId,
                    META_GRAPH_VERSION
                  );
                  if (media.audio.length > MAX_AUDIO_BYTES || (media.fileSize && media.fileSize > MAX_AUDIO_BYTES)) {
                    await sendWhatsAppMessage(
                      connection.accessToken,
                      connection.phoneNumberId,
                      event.senderId,
                      'Голосове повідомлення занадто велике. Надішліть, будь ласка, коротше.',
                      META_GRAPH_VERSION
                    );
                    continue;
                  }
                  incomingText = await transcribeAudio({
                    audio: media.audio,
                    mediaType: media.mediaType || event.audio.mediaType,
                    filename: 'whatsapp-voice.ogg',
                  });
                }
                if (!incomingText) continue;

                const history = await getHistory(
                  connection.propertyId,
                  'whatsapp',
                  event.senderId
                );
                history.push({ role: 'user', content: incomingText });

                if (await isTakenOverConversation(connection.propertyId, 'whatsapp', event.senderId)) {
                  await saveHistory(connection.propertyId, 'whatsapp', event.senderId, history);
                  continue;
                }

                const { replyText, updatedHistory } = await runConciergeTurn(
                  history,
                  { propertyId: connection.propertyId, propertyName: property.hotel_name, channel: 'whatsapp', chatId: event.senderId }
                );

                await saveHistory(
                  connection.propertyId,
                  'whatsapp',
                  event.senderId,
                  updatedHistory
                );

                await sendWhatsAppMessage(
                  connection.accessToken,
                  connection.phoneNumberId,
                  event.senderId,
                  replyText,
                  META_GRAPH_VERSION
                );
              } catch (error) {
                console.error('[whatsapp] EVENT ERROR:', error && error.stack ? error.stack : error);
              }
            }
          });
        }).catch(error => {
          console.error('[whatsapp] WEBHOOK ERROR:', error && error.stack ? error.stack : error);
          if (!res.headersSent) sendJson(res, 500, { error: error.message });
        });

        return;
      }

      // =========================
      // CORS
      // =========================

      if (
        req.method === 'OPTIONS' &&
        req.url.startsWith(
          '/webhook/website/'
        )
      ) {
        res.writeHead(
          204,
          {
            'Access-Control-Allow-Origin':
              '*',

            'Access-Control-Allow-Methods':
              'POST, OPTIONS',

            'Access-Control-Allow-Headers':
              'Content-Type',
          }
        );

        return res.end();
      }

      if (
        req.method === 'OPTIONS' &&
        [
          '/api/create-subscription-invoice',
          '/api/connect-channel',
          '/api/notify-signin',
          '/api/create-trial-invoice',
          '/api/cancel-auto-renew',
          '/api/rooms/parse-upload',
          '/api/disconnect-channel',
          '/api/contact',
          '/api/escalations/reply',
        ].includes(req.url)
      ) {
        res.writeHead(
          204,
          {
            'Access-Control-Allow-Origin':
              '*',

            'Access-Control-Allow-Methods':
              'POST, OPTIONS',

            'Access-Control-Allow-Headers':
              'Content-Type, Authorization',
          }
        );

        return res.end();
      }

      // =========================
      // TEST CHAT
      // =========================

      if (
        req.method === 'POST' &&
        req.url === '/chat'
      ) {
        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                }
              );
            }

            const {
              userId,
              message,
              propertyId,
            } = parsed;

            if (
              !userId ||
              !message ||
              !propertyId
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібні userId, message, propertyId.',
                }
              );
            }

            const property =
              await getProperty(
                propertyId
              );

            if (!property) {
              return sendJson(
                res,
                404,
                {
                  error:
                    'Готель не знайдено.',
                }
              );
            }

            if (
              !computeAccess(
                property
              ).allowed
            ) {
              return sendJson(
                res,
                200,
                {
                  reply:
                    PAUSED_MESSAGE,
                }
              );
            }

            const history =
              await getHistory(
                propertyId,
                'test',
                userId
              );

            history.push({
              role: 'user',
              content: message,
            });

            if (await isTakenOverConversation(propertyId, 'test', userId)) {
              await saveHistory(propertyId, 'test', userId, history);
              return sendJson(res, 200, { reply: '', takenOver: true });
            }

            try {
              const {
                replyText,
                updatedHistory,
              } =
                await runConciergeTurn(
                  history,
                  {
                    propertyId,
                    propertyName:
                      property.hotel_name,
                    channel: 'test',
                    chatId: userId,
                  }
                );

              await saveHistory(
                propertyId,
                'test',
                userId,
                updatedHistory
              );

              return sendJson(
                res,
                200,
                {
                  reply:
                    replyText,
                }
              );
            } catch (error) {
              return sendJson(
                res,
                500,
                {
                  error:
                    error.message,
                }
              );
            }
          }
        );

        return;
      }

      // =========================
      // TELEGRAM
      // =========================

      if (
        req.method === 'POST' &&
        req.url.startsWith(
          '/webhook/telegram/'
        )
      ) {
        const propertyId =
          decodeURIComponent(
            req.url.slice(
              '/webhook/telegram/'
                .length
            )
          );

        readBody(req).then(
          async body => {
            res.writeHead(
              200,
              {
                'Content-Type':
                  'application/json',
              }
            );

            res.end(
              '{"ok":true}'
            );

            let update;

            try {
              update =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return;
            }

            const parsed =
              parseTelegramUpdate(
                update
              );

            if (!parsed) return;

            const property =
              await getProperty(
                propertyId
              );

            if (!property) return;

            const botToken =
              await getTelegramToken(
                propertyId,
                property
              );

            if (!botToken) return;

            const {
              chatId,
              voice,
            } = parsed;

            if (
              !computeAccess(
                property
              ).allowed
            ) {
              try {
                await sendTelegramMessage(
                  botToken,
                  chatId,
                  PAUSED_MESSAGE
                );
              } catch {}

              return;
            }

            let text = parsed.text;
            if (voice) {
              if (voice.fileSize > MAX_AUDIO_BYTES) {
                await sendTelegramMessage(botToken, chatId, 'Голосове повідомлення занадто велике. Надішліть, будь ласка, коротше.');
                return;
              }
              try {
                const audio = await downloadTelegramFile(botToken, voice.fileId);
                if (audio.length > MAX_AUDIO_BYTES) {
                  await sendTelegramMessage(botToken, chatId, 'Голосове повідомлення занадто велике. Надішліть, будь ласка, коротше.');
                  return;
                }
                text = await transcribeAudio({
                  audio,
                  mediaType: voice.mediaType,
                  filename: 'telegram-voice.ogg',
                });
              } catch (error) {
                // Errors from transcription are already customer-safe.  Do
                // not log raw audio, bot credentials, or provider responses.
                console.error('[telegram voice]', error.code || 'VOICE_PROCESSING_ERROR');
                await sendTelegramMessage(botToken, chatId, error.message || 'Не вдалося розпізнати голосове повідомлення.');
                return;
              }
            }

            const history =
              await getHistory(
                propertyId,
                'telegram',
                chatId
              );

            history.push({
              role: 'user',
              content: text,
            });

            if (await isTakenOverConversation(propertyId, 'telegram', chatId)) {
              await saveHistory(propertyId, 'telegram', chatId, history);
              return;
            }

            try {
              const {
                replyText,
                updatedHistory,
              } =
                await runConciergeTurn(
                  history,
                  {
                    propertyId,
                    propertyName:
                      property.hotel_name,
                    channel: 'telegram',
                    chatId,
                  }
                );

              await saveHistory(
                propertyId,
                'telegram',
                chatId,
                updatedHistory
              );

              await sendTelegramMessage(
                botToken,
                chatId,
                replyText
              );
            } catch (error) {
              console.error(
                '[telegram]',
                error.message
              );
            }
          }
        );

        return;
      }

      // =========================
      // VIBER
      // =========================

      if (
        req.method === 'POST' &&
        req.url.startsWith(
          '/webhook/viber/'
        )
      ) {
        const propertyId =
          decodeURIComponent(
            req.url.slice(
              '/webhook/viber/'
                .length
            )
          );

        readBody(req).then(
          async body => {
            res.writeHead(
              200,
              {
                'Content-Type':
                  'application/json',
              }
            );

            res.end('{}');

            let update;

            try {
              update =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return;
            }

            if (
              update.event !==
              'message'
            ) {
              return;
            }

            const parsed =
              parseViberUpdate(
                update
              );

            if (!parsed) return;

            const property =
              await getProperty(
                propertyId
              );

            if (!property) return;

            const viberToken =
              await getViberToken(
                propertyId
              );

            if (!viberToken) return;

            const {
              chatId,
              text,
            } = parsed;

            if (
              !computeAccess(
                property
              ).allowed
            ) {
              try {
                await sendViberMessage(
                  viberToken,
                  chatId,
                  PAUSED_MESSAGE,
                  property.hotel_name
                );
              } catch {}

              return;
            }

            const history =
              await getHistory(
                propertyId,
                'viber',
                chatId
              );

            history.push({
              role: 'user',
              content: text,
            });

            if (await isTakenOverConversation(propertyId, 'viber', chatId)) {
              await saveHistory(propertyId, 'viber', chatId, history);
              return;
            }

            try {
              const {
                replyText,
                updatedHistory,
              } =
                await runConciergeTurn(
                  history,
                  {
                    propertyId,
                    propertyName:
                      property.hotel_name,
                    channel: 'viber',
                    chatId,
                  }
                );

              await saveHistory(
                propertyId,
                'viber',
                chatId,
                updatedHistory
              );

              await sendViberMessage(
                viberToken,
                chatId,
                replyText,
                property.hotel_name
              );
            } catch (error) {
              console.error(
                '[viber]',
                error.message
              );
            }
          }
        );

        return;
      }

      // =========================
      // WEBSITE
      // =========================

      if (
        req.method === 'POST' &&
        req.url.startsWith(
          '/webhook/website/'
        )
      ) {
        const propertyId =
          decodeURIComponent(
            req.url.slice(
              '/webhook/website/'
                .length
            )
          );

        const corsHeaders = {
          'Access-Control-Allow-Origin':
            '*',
        };

        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                },
                corsHeaders
              );
            }

            const {
              sessionId,
              message,
            } = parsed;

            if (
              !sessionId ||
              !message
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібні sessionId і message.',
                },
                corsHeaders
              );
            }

            if (
              String(message).length >
              2000
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Повідомлення занадто довге.',
                },
                corsHeaders
              );
            }

            const property =
              await getProperty(
                propertyId
              );

            if (!property) {
              return sendJson(
                res,
                404,
                {
                  error:
                    'Готель не знайдено.',
                },
                corsHeaders
              );
            }

            if (
              !computeAccess(
                property
              ).allowed
            ) {
              return sendJson(
                res,
                200,
                {
                  reply:
                    PAUSED_MESSAGE,
                },
                corsHeaders
              );
            }

            const history =
              await getHistory(
                propertyId,
                'website',
                sessionId
              );

            history.push({
              role: 'user',
              content:
                String(message),
            });

            if (await isTakenOverConversation(propertyId, 'website', sessionId)) {
              await saveHistory(propertyId, 'website', sessionId, history);
              return sendJson(res, 200, {
                reply: '',
                messageCount: history.length,
                takenOver: true,
              }, corsHeaders);
            }

            try {
              const {
                replyText,
                updatedHistory,
              } =
                await runConciergeTurn(
                  history,
                  {
                    propertyId,
                    propertyName:
                      property.hotel_name,
                    channel: 'website',
                    chatId: sessionId,
                  }
                );

              await saveHistory(
                propertyId,
                'website',
                sessionId,
                updatedHistory
              );

              return sendJson(
                res,
                200,
                {
                  reply:
                    replyText,
                  // Віджет запам'ятовує це число і зіставляє з ним подальші
                  // GET /api/website-chat/:propertyId/:sessionId — так він
                  // не показує повторно ці самі два повідомлення (гостя й
                  // бота), коли починає опитувати сервер на нові відповіді
                  // власника.
                  messageCount:
                    updatedHistory.length,
                },
                corsHeaders
              );
            } catch (error) {
              return sendJson(
                res,
                500,
                {
                  error:
                    error.message,
                },
                corsHeaders
              );
            }
          }
        );

        return;
      }

      // =========================
      // WEBSITE — опитування нових повідомлень (відповідь власника з
      // кабінету, Блок "Ескалації")
      // =========================

      if (req.method === 'GET' && req.url.startsWith('/api/website-chat/')) {
        const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
        const rest = req.url.slice('/api/website-chat/'.length).split('/');
        const propertyId = decodeURIComponent(rest[0] || '');
        const sessionId = decodeURIComponent(rest[1] || '');

        if (!propertyId || !sessionId) {
          return sendJson(res, 400, { error: 'Потрібні propertyId і sessionId у шляху.' }, corsHeaders);
        }

        (async () => {
          const messages = await getHistory(propertyId, 'website', sessionId);
          sendJson(res, 200, { messages }, corsHeaders);
        })();

        return;
      }

      // =========================
      // WAYFORPAY BOOKING
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/webhook/wayforpay'
      ) {
        readBody(req).then(
          async rawBody => {
            let payload;

            try {
              payload =
                JSON.parse(
                  rawBody
                );
            } catch {
              res.writeHead(400);
              return res.end();
            }

            const {
              orderReference,
              transactionStatus,
            } = payload;

            if (
              orderReference &&
              transactionStatus ===
                'Approved'
            ) {
              const { error } =
                await supabase
                  .from('bookings')
                  .update({
                    status:
                      'paid',
                  })
                  .eq(
                    'booking_id',
                    orderReference
                  );

              if (error) {
                console.error(
                  '[wayforpay booking]',
                  error
                );
              }
            }

            res.writeHead(
              200,
              {
                'Content-Type':
                  'application/json',
              }
            );

            res.end(
              JSON.stringify(
                wfpAcceptResponse(
                  orderReference
                )
              )
            );
          }
        );

        return;
      }

      // =========================
      // WAYFORPAY SUBSCRIPTION
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/webhook/wayforpay-subscription'
      ) {
        readBody(req).then(
          async rawBody => {
            let payload;

            try {
              payload =
                JSON.parse(
                  rawBody
                );
            } catch {
              res.writeHead(400);
              return res.end();
            }

            const {
              orderReference,
              transactionStatus,
            } = payload;

            if (
              orderReference &&
              transactionStatus ===
                'Approved'
            ) {
              const {
                data: order,
                error,
              } =
                await supabase
                  .from(
                    'subscription_orders'
                  )
                  .select(
                    'property_id, plan, is_trial_card'
                  )
                  .eq(
                    'order_id',
                    orderReference
                  )
                  .maybeSingle();

              if (
                !error &&
                order
              ) {
                await supabase
                  .from(
                    'subscription_orders'
                  )
                  .update({
                    status:
                      'paid',
                  })
                  .eq(
                    'order_id',
                    orderReference
                  );

                if (
                  order.is_trial_card
                ) {
                  const {
                    data: prop,
                  } =
                    await supabase
                      .from(
                        'properties'
                      )
                      .select(
                        'trial_ends_at'
                      )
                      .eq(
                        'property_id',
                        order.property_id
                      )
                      .maybeSingle();

                  const trialActive =
                    prop &&
                    prop.trial_ends_at &&
                    new Date(
                      prop.trial_ends_at
                    ) >
                      new Date();

                  const update = {
                    auto_renew: true,
                    last_auto_charge_failed:
                      false,
                  };

                  if (!trialActive) {
                    update.subscription_status =
                      'active';

                    update.subscription_plan =
                      order.plan;

                    update.subscription_active_until =
                      new Date(
                        Date.now() +
                          31 *
                            24 *
                            60 *
                            60 *
                            1000
                      ).toISOString();
                  }

                  await supabase
                    .from('properties')
                    .update(update)
                    .eq(
                      'property_id',
                      order.property_id
                    );
                } else {
                  await supabase
                    .from('properties')
                    .update({
                      subscription_status:
                        'active',

                      subscription_plan:
                        order.plan,

                      subscription_active_until:
                        new Date(
                          Date.now() +
                            31 *
                              24 *
                              60 *
                              60 *
                              1000
                        ).toISOString(),
                    })
                    .eq(
                      'property_id',
                      order.property_id
                    );
                }

                propertyCache.delete(
                  order.property_id
                );
              }
            }

            res.writeHead(
              200,
              {
                'Content-Type':
                  'application/json',
              }
            );

            res.end(
              JSON.stringify(
                wfpAcceptResponse(
                  orderReference
                )
              )
            );
          }
        );

        return;
      }

      // =========================
      // CREATE SUBSCRIPTION
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/api/create-subscription-invoice'
      ) {
        const corsHeaders = {
          'Access-Control-Allow-Origin':
            '*',
        };

        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                },
                corsHeaders
              );
            }

            const {
              propertyId,
              plan,
            } = parsed;

            if (
              !propertyId ||
              !plan
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібні propertyId і plan.',
                },
                corsHeaders
              );
            }

            const property =
              await getProperty(
                propertyId
              );

            if (!property) {
              return sendJson(
                res,
                404,
                {
                  error:
                    'Готель не знайдено.',
                },
                corsHeaders
              );
            }

            const orderId =
              'SUB' +
              Math.random()
                .toString(36)
                .slice(2, 8)
                .toUpperCase();

            try {
              const {
                invoiceUrl,
                priceEur,
              } =
                await createSubscriptionInvoice(
                  {
                    orderId,
                    plan,
                    propertyName:
                      property.hotel_name,
                  }
                );

              const {
                error,
              } =
                await supabase
                  .from(
                    'subscription_orders'
                  )
                  .insert({
                    order_id:
                      orderId,

                    property_id:
                      propertyId,

                    plan,

                    status:
                      'pending',

                    amount_eur:
                      priceEur,
                  });

              if (error) {
                return sendJson(
                  res,
                  500,
                  {
                    error:
                      'Не вдалося створити замовлення.',
                  },
                  corsHeaders
                );
              }

              return sendJson(
                res,
                200,
                {
                  invoiceUrl,
                  orderId,
                  priceEur,
                },
                corsHeaders
              );
            } catch (error) {
              return sendJson(
                res,
                500,
                {
                  error:
                    error.message,
                },
                corsHeaders
              );
            }
          }
        );

        return;
      }

      // =========================
      // CREATE TRIAL
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/api/create-trial-invoice'
      ) {
        const corsHeaders = {
          'Access-Control-Allow-Origin':
            '*',
        };

        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                },
                corsHeaders
              );
            }

            const {
              propertyId,
              plan,
            } = parsed;

            if (
              !propertyId ||
              !plan
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібні propertyId і plan.',
                },
                corsHeaders
              );
            }

            const property =
              await getProperty(
                propertyId
              );

            if (
              !property ||
              !property.trial_ends_at
            ) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Немає активного trial.',
                },
                corsHeaders
              );
            }

            const orderId =
              'TRL' +
              Math.random()
                .toString(36)
                .slice(2, 8)
                .toUpperCase();

            const dateBegin =
              Math.floor(
                new Date(
                  property.trial_ends_at
                ).getTime() /
                  1000
              );

            try {
              const {
                invoiceUrl,
                priceEur,
              } =
                await createSubscriptionInvoice(
                  {
                    orderId,
                    plan,
                    propertyName:
                      property.hotel_name,

                    autoRenewDateBegin:
                      dateBegin,
                  }
                );

              const {
                error,
              } =
                await supabase
                  .from(
                    'subscription_orders'
                  )
                  .insert({
                    order_id:
                      orderId,

                    property_id:
                      propertyId,

                    plan,

                    status:
                      'pending',

                    amount_eur:
                      priceEur,

                    is_trial_card:
                      true,
                  });

              if (error) {
                return sendJson(
                  res,
                  500,
                  {
                    error:
                      'Не вдалося створити trial.',
                  },
                  corsHeaders
                );
              }

              await supabase
                .from('properties')
                .update({
                  regular_payment_reference:
                    orderId,
                })
                .eq(
                  'property_id',
                  propertyId
                );

              propertyCache.delete(
                propertyId
              );

              return sendJson(
                res,
                200,
                {
                  invoiceUrl,
                  orderId,
                  priceEur,
                },
                corsHeaders
              );
            } catch (error) {
              return sendJson(
                res,
                500,
                {
                  error:
                    error.message,
                },
                corsHeaders
              );
            }
          }
        );

        return;
      }

      // =========================
      // CANCEL AUTO RENEW
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/api/cancel-auto-renew'
      ) {
        const corsHeaders = {
          'Access-Control-Allow-Origin':
            '*',
        };

        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                },
                corsHeaders
              );
            }

            const {
              propertyId,
            } = parsed;

            if (!propertyId) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібен propertyId.',
                },
                corsHeaders
              );
            }

            const {
              data: property,
            } =
              await supabase
                .from('properties')
                .select(
                  'regular_payment_reference'
                )
                .eq(
                  'property_id',
                  propertyId
                )
                .maybeSingle();

            if (!property) {
              return sendJson(
                res,
                404,
                {
                  error:
                    'Готель не знайдено.',
                },
                corsHeaders
              );
            }

            const {
              error,
            } =
              await supabase
                .from('properties')
                .update({
                  auto_renew:
                    false,

                  subscription_cancelled_at:
                    new Date().toISOString(),
                })
                .eq(
                  'property_id',
                  propertyId
                );

            if (error) {
              return sendJson(
                res,
                500,
                {
                  error:
                    'Не вдалося скасувати.',
                },
                corsHeaders
              );
            }

            propertyCache.delete(
              propertyId
            );

            let wfpResult = {
              ok: false,
              skipped: true,
            };

            if (
              property.regular_payment_reference
            ) {
              wfpResult =
                await cancelRegularPayment(
                  property.regular_payment_reference
                );
            }

            return sendJson(
              res,
              200,
              {
                ok: true,

                wayforpayConfirmed:
                  !!wfpResult.ok,
              },
              corsHeaders
            );
          }
        );

        return;
      }

      // =========================
      // LOGIN EMAIL
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/api/notify-signin'
      ) {
        const corsHeaders = {
          'Access-Control-Allow-Origin':
            '*',
        };

        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                },
                corsHeaders
              );
            }

            if (!parsed.email) {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Потрібен email.',
                },
                corsHeaders
              );
            }

            sendSignInNotification(
              parsed.email
            ).catch(() => {});

            return sendJson(
              res,
              200,
              {
                ok: true,
              },
              corsHeaders
            );
          }
        );

        return;
      }

      // =========================
      // CONTACT FORM (сторінка "Контакти")
      // =========================

      if (req.method === 'POST' && req.url === '/api/contact') {
        const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

        readBody(req).then(async (body) => {
          let parsed;
          try {
            parsed = JSON.parse(body || '{}');
          } catch {
            return sendJson(res, 400, { error: 'Некоректний JSON.' }, corsHeaders);
          }

          const name = String(parsed.name || '').trim().slice(0, 200);
          const email = String(parsed.email || '').trim().slice(0, 200);
          const message = String(parsed.message || '').trim().slice(0, 5000);

          if (!name || !email || !message) {
            return sendJson(res, 400, { error: "Заповніть ім'я, email і повідомлення." }, corsHeaders);
          }

          const result = await sendContactFormNotification(name, email, message);

          if (!result.telegramSent && !result.emailSent) {
            return sendJson(
              res,
              502,
              { ok: false, error: 'Не вдалося надіслати повідомлення. Напишіть нам напряму в Telegram або на пошту.' },
              corsHeaders
            );
          }

          return sendJson(res, 200, { ok: true }, corsHeaders);
        });

        return;
      }

      // =========================
      // ESCALATIONS (розділ "Ескалації" в кабінеті)
      // =========================

      if (req.method === 'POST' && req.url === '/api/escalations/reply') {
        const corsHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };

        readBody(req).then(async (body) => {
          let parsed;
          try {
            parsed = JSON.parse(body || '{}');
          } catch {
            return sendJson(res, 400, { error: 'Некоректний JSON.' }, corsHeaders);
          }

          const { propertyId, escalationId, message } = parsed;
          const text = String(message || '').trim();
          if (!propertyId || !escalationId || !text) {
            return sendJson(res, 400, { error: "Потрібні propertyId, escalationId, message." }, corsHeaders);
          }

          try {
            await requireOwnedProperty(req, propertyId);
          } catch (authError) {
            return sendJson(res, authError.status || 401, { error: authError.message }, corsHeaders);
          }

          const { data: escalation, error: escError } = await supabase
            .from('escalations')
            .select('id, property_id, channel, chat_id')
            .eq('id', escalationId)
            .eq('property_id', propertyId)
            .maybeSingle();
          if (escError || !escalation) {
            return sendJson(res, 404, { error: 'Ескалацію не знайдено.' }, corsHeaders);
          }
          if (!escalation.channel || !escalation.chat_id) {
            return sendJson(res, 400, { error: 'У цієї ескалації немає прив\'язаного діалогу (стара ескалація без каналу).' }, corsHeaders);
          }

          try {
            await sendReplyThroughChannel(propertyId, escalation.channel, escalation.chat_id, text);
          } catch (sendError) {
            return sendJson(res, 502, { error: sendError.message }, corsHeaders);
          }

          // Дописуємо відповідь власника в ту саму розмову, щоб вона була
          // видна в історії — так само, як автоматичні відповіді бота.
          const history = await getHistory(propertyId, escalation.channel, escalation.chat_id);
          history.push({ role: 'assistant', content: text, from_owner: true });
          await saveHistory(propertyId, escalation.channel, escalation.chat_id, history);

          return sendJson(res, 200, { ok: true }, corsHeaders);
        });

        return;
      }

      // =========================
      // CONNECT TELEGRAM / VIBER
      // =========================

      if (
        req.method === 'POST' &&
        req.url ===
          '/api/connect-channel'
      ) {
        const corsHeaders = {
          'Access-Control-Allow-Origin':
            '*',
        };

        readBody(req).then(
          async body => {
            let parsed;

            try {
              parsed =
                JSON.parse(
                  body || '{}'
                );
            } catch {
              return sendJson(
                res,
                400,
                {
                  error:
                    'Некоректний JSON.',
                },
                corsHeaders
              );
            }

            const {
              propertyId,
              channelType,
              credentials,
            } = parsed;

            if (!propertyId || !channelType || !credentials) {
              return sendJson(
                res,
                400,
                { error: 'Потрібні propertyId, channelType, credentials.' },
                corsHeaders
              );
            }

            try {
              await requireOwnedProperty(req, propertyId);
            } catch (authError) {
              return sendJson(res, authError.status || 401, { error: authError.message }, corsHeaders);
            }

            // ---- Telegram / Viber: webhook свого бота реєструється прямо
            // тут, credentials.bot_token — секрет, шифрується цілим об'єктом.
            if (channelType === 'telegram' || channelType === 'viber') {
              if (!credentials.bot_token) {
                return sendJson(res, 400, { error: 'Потрібен credentials.bot_token.' }, corsHeaders);
              }

              try {
                if (channelType === 'telegram') {
                  const result = await setTelegramWebhook(
                    credentials.bot_token,
                    `${API_BASE_URL}/webhook/telegram/${propertyId}`
                  );
                  if (!result.ok) throw new Error(result.description || 'Telegram error');
                } else {
                  const result = await setViberWebhook(
                    credentials.bot_token,
                    `${API_BASE_URL}/webhook/viber/${propertyId}`
                  );
                  if (result.status !== 0) throw new Error(result.status_message || 'Viber error');
                }
              } catch (error) {
                return sendJson(res, 400, { error: error.message }, corsHeaders);
              }

              const { error } = await supabase
                .from('channels')
                .upsert(
                  {
                    property_id: propertyId,
                    channel_type: channelType,
                    credentials: encryptCredentials(credentials),
                    connected: true,
                    status: 'connected',
                    status_detail: null,
                    connected_at: new Date().toISOString(),
                  },
                  { onConflict: 'property_id,channel_type' }
                );

              if (error) {
                return sendJson(res, 500, { error: 'Не вдалося зберегти канал.' }, corsHeaders);
              }
              invalidateChannel(propertyId, channelType);
              return sendJson(res, 200, { ok: true, status: 'connected' }, corsHeaders);
            }

            // ---- WhatsApp / Instagram / Messenger: перевіряємо токен
            // живим запитом до Meta Graph API, а не просто зберігаємо
            // сліпо (Блок 4 — кнопка має РЕАЛЬНО підключати, не бути
            // заглушкою). access_token шифрується окремо від
            // ідентифікатора (phone_number_id/ig_account_id/page_id),
            // який лишається відкритим — за ним шукає resolve*Connection
            // при вхідному вебхуці.
            if (channelType === 'whatsapp') {
              if (!credentials.phone_number_id || !credentials.access_token) {
                return sendJson(res, 400, { error: 'Потрібні credentials.phone_number_id і credentials.access_token.' }, corsHeaders);
              }
              const check = await verifyWhatsAppCredentials(credentials.access_token, credentials.phone_number_id, META_GRAPH_VERSION);
              if (check.status === 'error') {
                return sendJson(res, 400, { error: (check.details && check.details.error && check.details.error.message) || 'Не вдалося перевірити WhatsApp Phone Number ID / токен.' }, corsHeaders);
              }
              const stored = encryptCredentialsPartial({ phone_number_id: credentials.phone_number_id, access_token: credentials.access_token }, 'access_token');
              const { error } = await supabase
                .from('channels')
                .upsert(
                  {
                    property_id: propertyId,
                    channel_type: 'whatsapp',
                    credentials: stored,
                    connected: check.status === 'connected',
                    status: check.status,
                    status_detail: check.status === 'awaiting_verification' ? 'Очікує верифікації Meta Business. Активується автоматично, щойно Meta підтвердить бізнес-акаунт.' : null,
                    connected_at: new Date().toISOString(),
                  },
                  { onConflict: 'property_id,channel_type' }
                );
              if (error) return sendJson(res, 500, { error: 'Не вдалося зберегти канал.' }, corsHeaders);
              invalidateChannel(propertyId, 'whatsapp');
              return sendJson(res, 200, { ok: true, status: check.status }, corsHeaders);
            }

            if (channelType === 'instagram') {
              if (!credentials.instagram_account_id || !credentials.access_token) {
                return sendJson(res, 400, { error: 'Потрібні credentials.instagram_account_id і credentials.access_token.' }, corsHeaders);
              }
              const check = await verifyInstagramCredentials(credentials.access_token, credentials.instagram_account_id, META_GRAPH_VERSION);
              if (check.status === 'error') {
                return sendJson(res, 400, { error: (check.details && check.details.error && check.details.error.message) || 'Не вдалося перевірити Instagram Account ID / токен.' }, corsHeaders);
              }
              const stored = encryptCredentialsPartial({ instagram_account_id: credentials.instagram_account_id, access_token: credentials.access_token }, 'access_token');
              const { error } = await supabase
                .from('channels')
                .upsert(
                  {
                    property_id: propertyId,
                    channel_type: 'instagram',
                    credentials: stored,
                    connected: check.status === 'connected',
                    status: check.status,
                    status_detail: check.status === 'awaiting_verification' ? 'Очікує верифікації Meta Business. Активується автоматично, щойно Meta підтвердить бізнес-акаунт.' : null,
                    connected_at: new Date().toISOString(),
                  },
                  { onConflict: 'property_id,channel_type' }
                );
              if (error) return sendJson(res, 500, { error: 'Не вдалося зберегти канал.' }, corsHeaders);
              invalidateChannel(propertyId, 'instagram');
              return sendJson(res, 200, { ok: true, status: check.status }, corsHeaders);
            }

            if (channelType === 'messenger') {
              if (!credentials.access_token) {
                return sendJson(res, 400, { error: 'Потрібен credentials.access_token (Page Access Token).' }, corsHeaders);
              }
              const check = await verifyMessengerCredentials(credentials.access_token, META_GRAPH_VERSION);
              if (check.status === 'error') {
                return sendJson(res, 400, { error: (check.details && check.details.error && check.details.error.message) || 'Не вдалося перевірити Page Access Token.' }, corsHeaders);
              }
              const pageId = check.details && check.details.id;
              if (check.status === 'connected' && !pageId) {
                return sendJson(res, 400, { error: 'Meta не повернула ID сторінки — перевірте токен.' }, corsHeaders);
              }
              const stored = encryptCredentialsPartial(
                { page_id: pageId || credentials.page_id || '', page_name: (check.details && check.details.name) || '', access_token: credentials.access_token },
                'access_token'
              );
              const { error } = await supabase
                .from('channels')
                .upsert(
                  {
                    property_id: propertyId,
                    channel_type: 'messenger',
                    credentials: stored,
                    connected: check.status === 'connected',
                    status: check.status,
                    status_detail: check.status === 'awaiting_verification' ? 'Очікує верифікації Meta Business. Активується автоматично, щойно Meta підтвердить бізнес-акаунт.' : null,
                    connected_at: new Date().toISOString(),
                  },
                  { onConflict: 'property_id,channel_type' }
                );
              if (error) return sendJson(res, 500, { error: 'Не вдалося зберегти канал.' }, corsHeaders);
              invalidateChannel(propertyId, 'messenger');
              return sendJson(res, 200, { ok: true, status: check.status }, corsHeaders);
            }

            return sendJson(res, 400, { error: `Невідомий тип каналу: ${channelType}.` }, corsHeaders);
          }
        );

        return;
      }

      if (
        req.method === 'POST' &&
        req.url === '/api/disconnect-channel'
      ) {
        const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

        readBody(req).then(async (body) => {
          let parsed;
          try {
            parsed = JSON.parse(body || '{}');
          } catch {
            return sendJson(res, 400, { error: 'Некоректний JSON.' }, corsHeaders);
          }

          const { propertyId, channelType } = parsed;
          if (!propertyId || !channelType) {
            return sendJson(res, 400, { error: 'Потрібні propertyId, channelType.' }, corsHeaders);
          }

          try {
            await requireOwnedProperty(req, propertyId);
          } catch (authError) {
            return sendJson(res, authError.status || 401, { error: authError.message }, corsHeaders);
          }

          // Telegram/Viber тримають вебхук на боці самого месенджера —
          // відключення не просто прапорець у БД, а реальне видалення
          // підписки, інакше бот і далі надсилатиме апдейти в нікуди.
          if (channelType === 'telegram' || channelType === 'viber') {
            const { data: channel } = await supabase
              .from('channels')
              .select('credentials')
              .eq('property_id', propertyId)
              .eq('channel_type', channelType)
              .maybeSingle();

            const botToken = channel && channel.credentials && decryptCredentials(channel.credentials).bot_token;
            if (botToken) {
              try {
                if (channelType === 'telegram') await setTelegramWebhook(botToken, '');
                else await setViberWebhook(botToken, '');
              } catch (error) {
                console.error(`[disconnect-channel] Failed to unset ${channelType} webhook:`, error.message);
              }
            }
          }

          const { error } = await supabase
            .from('channels')
            .upsert(
              {
                property_id: propertyId,
                channel_type: channelType,
                credentials: {},
                connected: false,
                status: 'disconnected',
                status_detail: null,
              },
              { onConflict: 'property_id,channel_type' }
            );

          if (error) {
            return sendJson(res, 500, { error: 'Не вдалося відключити канал.' }, corsHeaders);
          }
          invalidateChannel(propertyId, channelType);
          return sendJson(res, 200, { ok: true }, corsHeaders);
        });

        return;
      }

      if (
        req.method === 'POST' &&
        req.url === '/api/rooms/parse-upload'
      ) {
        const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

        let bb;
        try {
          bb = busboy({ headers: req.headers, limits: { fileSize: ROOMS_MAX_FILE_SIZE_BYTES, files: 1 } });
        } catch (error) {
          return sendJson(res, 400, { error: 'Некоректний запит завантаження файлу.' }, corsHeaders);
        }

        let propertyId = '';
        let fileName = '';
        let fileChunks = [];
        let fileTooLarge = false;
        let sawFile = false;

        bb.on('field', (name, value) => {
          if (name === 'propertyId') propertyId = value;
        });

        bb.on('file', (name, stream, info) => {
          sawFile = true;
          fileName = (info && info.filename) || '';
          stream.on('data', (chunk) => fileChunks.push(chunk));
          stream.on('limit', () => { fileTooLarge = true; });
        });

        bb.on('error', (error) => {
          if (!res.headersSent) {
            sendJson(res, 400, { error: 'Не вдалося прочитати файл: ' + error.message }, corsHeaders);
          }
        });

        bb.on('close', async () => {
          if (res.headersSent) return;
          try {
            if (fileTooLarge) {
              return sendJson(res, 413, { error: `Файл завеликий — максимум ${Math.round(ROOMS_MAX_FILE_SIZE_BYTES / (1024 * 1024))} МБ.` }, corsHeaders);
            }
            if (!sawFile || !fileChunks.length) {
              return sendJson(res, 400, { error: 'Файл не завантажено.' }, corsHeaders);
            }
            if (!propertyId) {
              return sendJson(res, 400, { error: 'Не вказано готель (propertyId).' }, corsHeaders);
            }

            await requireOwnedProperty(req, propertyId);

            const fileBuffer = Buffer.concat(fileChunks);
            const { rooms, source } = await extractRoomsFromFile(fileBuffer, fileName);

            if (!rooms.length) {
              return sendJson(res, 200, {
                ok: true,
                rooms: [],
                source,
                warning: 'Не вдалося розпізнати жодного номера в цьому файлі. Перевірте, чи файл містить назви номерів і ціни, або скористайтеся шаблоном.',
              }, corsHeaders);
            }

            const { data: existingRooms, error: existingError } = await supabase
              .from('rooms')
              .select('id, room_type, price_per_night, capacity, quantity, description')
              .eq('property_id', propertyId);

            if (existingError) {
              console.error('[rooms/parse-upload] existing rooms lookup error:', existingError);
            }

            const roomsWithDuplicates = markDuplicates(rooms, existingRooms || []);
            return sendJson(res, 200, { ok: true, rooms: roomsWithDuplicates, source }, corsHeaders);
          } catch (error) {
            console.error('[rooms/parse-upload]', error);
            return sendJson(res, error.status || 500, { error: error.message || 'Помилка при обробці файлу.' }, corsHeaders);
          }
        });

        req.pipe(bb);
        return;
      }

      if (
        req.method === 'GET' &&
        req.url === '/health'
      ) {
        return sendJson(
          res,
          200,
          {
            ok: true,
          }
        );
      }

      return sendJson(
        res,
        404,
        {
          error:
            'Not found',
        }
      );
    }
  );

server.listen(
  PORT,
  () => {
    console.log(
      `StayAI concierge server running on http://localhost:${PORT}`
    );

    console.log(
      '[messenger] Configured:',
      {
        pageId:
          META_MESSENGER_PAGE_ID ||
          'not_set',

        propertyId:
          META_MESSENGER_PROPERTY_ID ||
          'not_set',
      }
    );

    console.log(
      '[whatsapp] Configured:',
      {
        phoneNumberId: META_WHATSAPP_PHONE_NUMBER_ID || 'not_set',
        propertyId: META_WHATSAPP_PROPERTY_ID || 'not_set',
        hasAccessToken: !!META_WHATSAPP_ACCESS_TOKEN,
        hasVerifyToken: !!META_WHATSAPP_VERIFY_TOKEN,
      }
    );

    console.log(
      '[instagram] Configured:',
      {
        accountId:
          META_INSTAGRAM_ACCOUNT_ID ||
          'not_set',

        propertyId:
          META_INSTAGRAM_PROPERTY_ID ||
          'not_set',

        hasAccessToken:
          !!META_INSTAGRAM_ACCESS_TOKEN,

        hasVerifyToken:
          !!META_INSTAGRAM_VERIFY_TOKEN,
      }
    );
  }
);
