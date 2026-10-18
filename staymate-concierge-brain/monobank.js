/*
 * Monobank "особистий API" — безкоштовне, миттєве (без заявок) підключення
 * для готелю, щоб StayAI міг сам бачити, чи прийшла оплата бронювання на
 * рахунок готелю, і автоматично позначати бронь оплаченою — без жодного
 * платіжного шлюзу чи мерчант-акаунта з боку готелю.
 *
 * Офіційний ліміт Monobank: не більше 1 запиту на /personal/statement за
 * 60 секунд НА ОДИН токен — виклики цього модуля мають плануватись з
 * інтервалом, що це поважає (див. runMonobankPaymentChecks у server.js).
 */

const MONOBANK_API_URL = 'https://api.monobank.ua';
const STATEMENT_MAX_RANGE_SECONDS = 31 * 24 * 60 * 60; // обмеження самого Monobank API

async function verifyMonobankToken(token, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch недоступний у цьому середовищі.');
  }
  if (!token) {
    return { ok: false, error: 'Потрібен токен Monobank API.' };
  }

  let response;
  try {
    response = await fetchImpl(`${MONOBANK_API_URL}/personal/client-info`, {
      headers: { 'X-Token': token },
    });
  } catch (error) {
    return { ok: false, error: `Не вдалося з'єднатися з Monobank: ${error.message}` };
  }

  if (!response.ok) {
    return { ok: false, error: `Monobank відхилив токен (HTTP ${response.status}).` };
  }

  const data = await response.json().catch(() => null);
  return { ok: true, name: (data && data.name) || '' };
}

async function fetchMonobankStatement(token, { account = '0', fromSeconds, toSeconds, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch недоступний у цьому середовищі.');
  }
  const to = toSeconds || Math.floor(Date.now() / 1000);
  let from = fromSeconds || to - 3600;
  if (to - from > STATEMENT_MAX_RANGE_SECONDS) {
    from = to - STATEMENT_MAX_RANGE_SECONDS;
  }

  const response = await fetchImpl(
    `${MONOBANK_API_URL}/personal/statement/${account}/${from}/${to}`,
    { headers: { 'X-Token': token } }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Monobank API: HTTP ${response.status}${text ? ' — ' + text : ''}`);
  }
  return response.json();
}

// Гість просять дописати короткий код у коментар до переказу — так один
// і той самий збіг суми не плутається між кількома бронями, що чекають
// оплати одночасно. Сума звіряється в копійках (amount у Monobank — це
// цілі копійки, додатні для надходжень).
function findMatchingTransaction(transactions, { totalPrice, reference }) {
  const expectedKopecks = Math.round(Number(totalPrice) * 100);
  if (!Number.isFinite(expectedKopecks) || expectedKopecks <= 0) return null;

  const match = (transactions || []).find((t) => {
    if (!t || typeof t.amount !== 'number' || t.amount !== expectedKopecks) return false;
    if (!reference) return true;
    return String(t.comment || '').toUpperCase().includes(String(reference).toUpperCase());
  });
  return match || null;
}

// Internet acquiring is deliberately distinct from the personal-account API
// above.  A dedicated merchant token is required; never reuse a hotel's
// personal statement token for card acquiring.
async function createMonobankInvoice(token, { amountKopecks, reference, destination, webHookUrl, redirectUrl, validitySeconds = 86400, fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new Error('Monobank acquiring token is not configured.');
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) throw new Error('Invalid invoice amount.');
  const response = await fetchImpl(`${MONOBANK_API_URL}/api/merchant/invoice/create`, {
    method: 'POST', headers: { 'X-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountKopecks, ccy: 980, merchantPaymInfo: { reference, destination, comment: destination, basketOrder: [{ name: destination, qty: 1, sum: amountKopecks, total: amountKopecks, unit: 'послуга', code: reference }] }, redirectUrl, webHookUrl, validity: validitySeconds, paymentType: 'debit' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.invoiceId || !data.pageUrl) throw new Error(`Monobank acquiring invoice failed (HTTP ${response.status}).`);
  const page = new URL(data.pageUrl);
  if (page.protocol !== 'https:' || !['pay.mbnk.biz', 'pay.monobank.ua'].includes(page.hostname)) throw new Error('Monobank returned an untrusted payment URL.');
  return { invoiceId: String(data.invoiceId), pageUrl: data.pageUrl };
}

async function getMonobankMerchantPublicKey(token, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(`${MONOBANK_API_URL}/api/merchant/pubkey`, { headers: { 'X-Token': token } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.key) throw new Error('Monobank merchant public key is unavailable.');
  const decoded = Buffer.from(data.key, 'base64').toString('utf8');
  return decoded.includes('BEGIN PUBLIC KEY') ? decoded : data.key;
}

async function getMonobankInvoiceStatus(token, invoiceId, { fetchImpl = globalThis.fetch } = {}) {
  if (!token || !invoiceId) throw new Error('Merchant token and invoice ID are required.');
  const url = `${MONOBANK_API_URL}/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`;
  const response = await fetchImpl(url, { headers: { 'X-Token': token } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.invoiceId) throw new Error(`Monobank invoice status failed (HTTP ${response.status}).`);
  return data;
}

function verifyMonobankAcquiringSignature(rawBody, xSign, publicKey) {
  if (!rawBody || !xSign || !publicKey) return false;
  try {
    const key = String(publicKey).includes('BEGIN PUBLIC KEY') ? publicKey : { key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' };
    return require('crypto').verify('sha256', Buffer.from(rawBody), key, Buffer.from(xSign, 'base64'));
  } catch { return false; }
}

module.exports = { verifyMonobankToken, fetchMonobankStatement, findMatchingTransaction, createMonobankInvoice, getMonobankMerchantPublicKey, getMonobankInvoiceStatus, verifyMonobankAcquiringSignature };
