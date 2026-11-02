/* ============================================================
   StayAI — Meta OAuth ("Увійти через Facebook") для самостійного
   підключення Messenger / Instagram / WhatsApp власником готелю,
   замість ручного вставляння токенів і ID.

   Facebook Login for Business (Pages+Instagram) і WhatsApp Embedded
   Signup тепер обидва працюють через конфігурації з власним config_id
   (створюються в Meta App Dashboard), а не через "scope=" — сам OAuth
   код (/oauth/access_token обмін) при цьому лишається стандартним.
   ============================================================ */

const GRAPH_API_BASE = 'https://graph.facebook.com';

async function graphCall(method, path, { params = {}, accessToken, graphVersion = 'v24.0', fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch недоступний у цьому середовищі.');
  }

  const query = new URLSearchParams(params);
  if (accessToken) query.set('access_token', accessToken);

  const url = `${GRAPH_API_BASE}/${graphVersion}/${path}${method === 'GET' ? `?${query}` : ''}`;
  const init = method === 'GET'
    ? { method }
    : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: query.toString() };

  const response = await fetchImpl(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (body && body.error && body.error.message) || `HTTP ${response.status}`;
    const error = new Error(`Meta Graph API (${path}): ${message}`);
    error.graphError = body && body.error;
    throw error;
  }
  return body;
}

/**
 * Обмінює код авторизації (отриманий від FB.login() у браузері) на
 * короткоживучий User Access Token. Для коду, отриманого через JS SDK
 * (а не класичний серверний redirect), redirect_uri лишається порожнім —
 * саме так його й використовував сам SDK під час логіну.
 */
async function exchangeCodeForToken({ code, appId, appSecret, redirectUri = '', graphVersion, fetchImpl }) {
  const data = await graphCall('GET', 'oauth/access_token', {
    params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
    graphVersion,
    fetchImpl,
  });
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

/** Короткоживучий токен → довгоживучий (~60 днів). */
async function exchangeForLongLivedToken({ shortLivedToken, appId, appSecret, graphVersion, fetchImpl }) {
  const data = await graphCall('GET', 'oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLivedToken,
    },
    graphVersion,
    fetchImpl,
  });
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

/** Сторінки, якими власник керує і до яких дав доступ під час логіну. */
async function listPages({ userToken, graphVersion, fetchImpl }) {
  const data = await graphCall('GET', 'me/accounts', {
    params: { fields: 'id,name,access_token' },
    accessToken: userToken,
    graphVersion,
    fetchImpl,
  });
  return data.data || [];
}

/** Instagram-акаунт, пов'язаний зі сторінкою (якщо є). */
async function getPageInstagramAccount({ pageId, pageToken, graphVersion, fetchImpl }) {
  const data = await graphCall('GET', pageId, {
    params: { fields: 'instagram_business_account{id,username}' },
    accessToken: pageToken,
    graphVersion,
    fetchImpl,
  });
  return data.instagram_business_account || null;
}

/**
 * Підписує сторінку на вебхуки застосунку — без цього Meta не
 * надсилатиме вхідні повідомлення Messenger/Instagram на наш вебхук,
 * навіть якщо токен і права коректні.
 */
async function subscribePageWebhooks({ pageId, pageToken, graphVersion, fetchImpl }) {
  return graphCall('POST', `${pageId}/subscribed_apps`, {
    params: { subscribed_fields: 'messages,messaging_postbacks,message_reads' },
    accessToken: pageToken,
    graphVersion,
    fetchImpl,
  });
}

/** Реєструє номер WhatsApp Cloud API (обов'язковий крок після Embedded Signup). */
async function registerWhatsAppNumber({ phoneNumberId, accessToken, pin, graphVersion, fetchImpl }) {
  return graphCall('POST', `${phoneNumberId}/register`, {
    params: { messaging_product: 'whatsapp', pin },
    accessToken,
    graphVersion,
    fetchImpl,
  });
}

/** Підписує WhatsApp Business Account на вебхуки застосунку. */
async function subscribeWabaWebhooks({ wabaId, accessToken, graphVersion, fetchImpl }) {
  return graphCall('POST', `${wabaId}/subscribed_apps`, {
    accessToken,
    graphVersion,
    fetchImpl,
  });
}

async function listWabaPhoneNumbers({ wabaId, accessToken, graphVersion, fetchImpl }) {
  const data = await graphCall('GET', String(wabaId) + '/phone_numbers', {
    params: { fields: 'id,display_phone_number', limit: '100' },
    accessToken, graphVersion, fetchImpl,
  });
  return Array.isArray(data.data) ? data.data : [];
}

async function getPhoneMode({ phoneNumberId, accessToken, graphVersion, fetchImpl }) {
  return graphCall('GET', phoneNumberId, {
    params: { fields: 'is_on_biz_app,platform_type' },
    accessToken, graphVersion, fetchImpl,
  });
}

function isValidMetaSdkRedirectUri(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value) return false;
  try {
    const uri = new URL(value);
    if (uri.protocol !== 'https:' || uri.hostname !== 'staticxx.facebook.com'
        || uri.port || uri.username || uri.password
        || uri.pathname !== '/x/connect/xd_arbiter/') return false;
    const hashParams = new URLSearchParams(uri.hash.slice(1));
    if (hashParams.get('domain') !== 'stayai.online') return false;
    const origin = new URL(hashParams.get('origin') || '');
    return origin.origin === 'https://stayai.online';
  } catch {
    return false;
  }
}

module.exports = {
  isValidMetaSdkRedirectUri,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  listPages,
  getPageInstagramAccount,
  subscribePageWebhooks,
  registerWhatsAppNumber,
  subscribeWabaWebhooks,
  listWabaPhoneNumbers,
  getPhoneMode,
};
