/* ============================================================
   StayAI — перевірка токенів Meta (WhatsApp/Instagram/Messenger),
   Блок 4.

   Кожен канал перевіряється одним легким GET-запитом до Graph API,
   щоб кнопка "Підключити" не була заглушкою: якщо токен/ID справді
   робочі — підключаємо одразу; якщо Meta відмовляє через відсутність
   App/Business Verification — не показуємо це як помилку користувачу,
   а зберігаємо канал зі статусом "очікує верифікації Meta" (credentials
   вже збережені, активується сам після проходження верифікації); якщо
   причина інша (невірний токен/ID) — це реальна помилка.

   ВАЖЛИВО: класифікація кодів помилок Meta (classifyMetaError) складена
   за публічною документацією Graph API, але не перевірена проти живих
   відповідей реального Meta-додатка (в цьому середовищі немає доступу
   до верифікованого Meta Business акаунта StayAI) — після отримання
   реальних облікових даних варто звірити фактичні коди помилок і за
   потреби розширити список нижче.
   ============================================================ */

async function graphGet(path, accessToken, graphVersion = 'v24.0') {
  const url = `https://graph.facebook.com/${graphVersion}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  return { httpOk: response.ok, status: response.status, body };
}

// Коди/підкоди Graph API, які типово означають "додаток чи бізнес ще не
// пройшов Meta App/Business Verification" або "потрібен review дозволу",
// а не "токен невірний". Джерело: публічна документація Meta про коди
// помилок авторизації (OAuthException 10/200/368, permission errors).
const VERIFICATION_PENDING_INDICATORS = [10, 200, 368];

function classifyMetaError(errorBody) {
  const err = (errorBody && errorBody.error) || {};
  const code = err.code;
  const message = String(err.message || '').toLowerCase();

  if (VERIFICATION_PENDING_INDICATORS.includes(code)) return 'awaiting_verification';
  if (message.includes('permission') || message.includes('review') || message.includes('verification') || message.includes('does not have permission')) {
    return 'awaiting_verification';
  }
  return 'error';
}

/**
 * Перевіряє WhatsApp Cloud API: чи дійсно accessToken має доступ до
 * phoneNumberId.
 */
async function verifyWhatsAppCredentials(accessToken, phoneNumberId, graphVersion) {
  const result = await graphGet(`${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number`, accessToken, graphVersion);
  if (result.httpOk) return { status: 'connected', details: result.body };
  return { status: classifyMetaError(result.body), details: result.body, httpStatus: result.status };
}

/** Перевіряє Instagram: чи accessToken має доступ до igAccountId. */
async function verifyInstagramCredentials(accessToken, igAccountId, graphVersion) {
  const result = await graphGet(`${encodeURIComponent(igAccountId)}?fields=id,username`, accessToken, graphVersion);
  if (result.httpOk) return { status: 'connected', details: result.body };
  return { status: classifyMetaError(result.body), details: result.body, httpStatus: result.status };
}

/**
 * Перевіряє Facebook Page Access Token і заразом дізнається page_id
 * (потрібен, щоб роутити вхідні повідомлення на правильний готель).
 */
async function verifyMessengerCredentials(pageAccessToken, graphVersion) {
  const result = await graphGet('me?fields=id,name', pageAccessToken, graphVersion);
  if (result.httpOk) return { status: 'connected', details: result.body };
  return { status: classifyMetaError(result.body), details: result.body, httpStatus: result.status };
}

module.exports = { verifyWhatsAppCredentials, verifyInstagramCredentials, verifyMessengerCredentials, classifyMetaError };
