/* ============================================================
   StayAI — шифрування токенів каналів (Блок 4)
   channels.credentials зберігає access-токени WhatsApp/Instagram/
   Messenger/Telegram/Viber — це секрети конкретного готелю, тому
   зберігаються в БД не у відкритому вигляді, а AES-256-GCM,
   з ключем ТІЛЬКИ у змінній середовища (ніколи в коді/репозиторії).
   ============================================================ */

const crypto = require('crypto');

const ENC_TAG = 'aes-256-gcm-v1';

function getKeyBuffer() {
  const raw = process.env.CHANNEL_CREDENTIALS_ENCRYPTION_KEY || '';
  if (!raw) {
    throw new Error('CHANNEL_CREDENTIALS_ENCRYPTION_KEY не встановлено в змінних середовища.');
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 32) return buf;
  throw new Error('CHANNEL_CREDENTIALS_ENCRYPTION_KEY має бути 32 байти: 64 hex-символи або base64.');
}

function encryptString(plaintextStr) {
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(String(plaintextStr), 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    __enc: ENC_TAG,
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptString(stored) {
  if (!stored || stored.__enc !== ENC_TAG) return null;
  const key = getKeyBuffer();
  const iv = Buffer.from(stored.iv, 'base64');
  const tag = Buffer.from(stored.tag, 'base64');
  const data = Buffer.from(stored.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

/** Шифрує довільний JSON-об'єкт credentials перед записом у Supabase. */
function encryptCredentials(obj) {
  return encryptString(JSON.stringify(obj || {}));
}

/**
 * Шифрує ОДНЕ секретне поле (access_token) всередині об'єкта credentials,
 * лишаючи решту полів (instagram_account_id, phone_number_id, page_id —
 * не секрети, потрібні для пошуку каналу за вхідним вебхуком через
 * Supabase .contains()) у відкритому вигляді. На відміну від
 * encryptCredentials (шифрує весь об'єкт — використовується для
 * telegram/viber, де пошук завжди йде за property_id, а не за вмістом
 * credentials).
 */
function encryptCredentialsPartial(obj, secretField = 'access_token') {
  const { [secretField]: secretValue, ...rest } = obj || {};
  if (secretValue === undefined) return { ...rest };
  return { ...rest, [`${secretField}_enc`]: encryptString(secretValue) };
}

function decryptCredentialsPartial(stored, secretField = 'access_token') {
  if (!stored || typeof stored !== 'object') return stored;
  const encKey = `${secretField}_enc`;
  if (!stored[encKey]) return stored; // старі незашифровані рядки — сумісність назад
  const { [encKey]: encValue, ...rest } = stored;
  return { ...rest, [secretField]: decryptString(encValue) };
}

/**
 * Розшифровує credentials, прочитані з Supabase. Рядки, записані ДО
 * впровадження шифрування (немає __enc), повертаються як є — зворотна
 * сумісність із каналами, підключеними раніше.
 */
function decryptCredentials(stored) {
  if (!stored || typeof stored !== 'object') return stored;
  if (stored.__enc !== ENC_TAG) return stored;

  const key = getKeyBuffer();
  const iv = Buffer.from(stored.iv, 'base64');
  const tag = Buffer.from(stored.tag, 'base64');
  const data = Buffer.from(stored.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

module.exports = {
  encryptCredentials,
  decryptCredentials,
  encryptCredentialsPartial,
  decryptCredentialsPartial,
};
