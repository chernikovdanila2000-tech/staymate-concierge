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

module.exports = { verifyMonobankToken, fetchMonobankStatement, findMatchingTransaction };
