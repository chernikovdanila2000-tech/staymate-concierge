/* ============================================================
   StayAI — конфігурація Supabase (справжні акаунти StayAI)
   ------------------------------------------------------------
   Що зробити один раз, щоб акаунти запрацювали по-справжньому:

   1) Зареєструйтесь безкоштовно на https://supabase.com і створіть
      новий проєкт (Create new project). Оберіть ім'я, пароль бази
      даних і регіон — це не впливає на код нижче.

   2) У проєкті зліва відкрийте: Project Settings (шестерня внизу
      лівого меню) → вкладка API Keys (або "API" у старому
      інтерфейсі).

      Скопіюйте ДВА значення:
        - "Project URL" — коротке посилання виду
          https://xxxxxxxxxxx.supabase.co
          (НЕ берете значення з розділу "Data API" / "Integrations" —
          там показаний інший, довший технічний адрес з /rest/v1/
          в кінці, він тут не підходить)
        - "anon" / "public" ключ (або "Publishable key" на нових
          проєктах) — довгий рядок, зазвичай починається на eyJ...

      Код нижче сам приберe зайве, якщо ви випадково скопіюєте
      URL з "/rest/v1/" в кінці — але краще одразу брати короткий
      Project URL.

   3) У Supabase зліва відкрийте SQL Editor → New query,
      вставте туди весь вміст файлу supabase-schema.sql з цього
      архіву і натисніть Run. Це створить таблицю підписок.

   4) (Необов'язково, але зручно для тестування) У Supabase:
      Authentication → Providers → Email → вимкніть
      "Confirm email", якщо не хочете підтверджувати пошту
      під час тестування. Для реального запуску краще залишити
      підтвердження увімкненим.

   5) Вставте свої два значення нижче ЗАМІСТЬ плейсхолдерів
      (усередині лапок), збережіть файл і закиньте його поруч з
      рештою файлів сайту (в ту саму папку) — він підключений на
      кожній сторінці.

   ВАЖЛИВО: після будь-якої зміни цього файлу — обов'язково
   перезалийте ВСЮ папку (усі 13 файлів) на хостинг, не тільки
   цей файл окремо. Інакше сторінки продовжать використовувати
   стару версію коду.
============================================================ */

// Той самий проєкт і публічний (publishable/anon) ключ, що вже вшиті в
// cabinet/index.html — це не секрет: доступ до даних обмежує Row Level
// Security в Supabase, а не приховування цього ключа.
const SUPABASE_URL_RAW = "https://nyknlyufbwjodbpyehtv.supabase.co";
const SUPABASE_ANON_KEY_RAW = "sb_publishable_JVLVW1ckRPOy2sLgYraMng_KPDMANV3";

/* --- захист від типових помилок копіювання, нічого тут міняти не треба --- */
function cleanSupabaseUrl(url) {
  let u = String(url || "").trim();
  u = u.replace(/\/rest\/v1\/?.*$/i, "");  // прибрати "/rest/v1/..." якщо скопійовано не той адрес
  u = u.replace(/\/+$/, "");                // прибрати кінцевий "/"
  return u;
}
const SUPABASE_URL = cleanSupabaseUrl(SUPABASE_URL_RAW);
const SUPABASE_ANON_KEY = String(SUPABASE_ANON_KEY_RAW || "").trim();

const SUPABASE_CONFIGURED = !!(
  SUPABASE_URL &&
  SUPABASE_ANON_KEY &&
  !SUPABASE_URL.startsWith("PASTE_") &&
  !SUPABASE_ANON_KEY.startsWith("PASTE_") &&
  SUPABASE_URL.startsWith("https://") &&
  SUPABASE_URL.includes(".supabase.co")
);

window.sb = null;
if (SUPABASE_CONFIGURED && window.supabase) {
  // 570d220 temporarily changed the launch-board auth key. Move that session
  // back to Supabase's stable project key once, so owners stay signed in.
  try {
    const legacyAuthKey = 'stayai-launch-board-auth';
    const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];
    const projectAuthKey = `sb-${projectRef}-auth-token`;
    if (!localStorage.getItem(projectAuthKey) && localStorage.getItem(legacyAuthKey)) {
      localStorage.setItem(projectAuthKey, localStorage.getItem(legacyAuthKey));
    }
    localStorage.removeItem(legacyAuthKey);
  } catch (_) {
    // Storage can be unavailable in hardened/private contexts; Auth reports it.
  }
  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce'
    }
  });
}
