/*
 * NOWPayments — приймання оплати підписки StayAI криптовалютою (альтернатива
 * WayForPay для власників, які хочуть платити криптою замість картки).
 *
 * is_fixed_rate + is_fee_paid_by_user: фіксує курс на момент виставлення
 * рахунку і перекладає мережеву/обмінну комісію (зазвичай ~1–1.5%) на
 * платника — так StayAI отримує повну суму тарифу, а не суму мінус комісія.
 * Ці два поля пов'язані: NOWPayments вмикає is_fixed_rate автоматично, якщо
 * is_fee_paid_by_user === true.
 */

const crypto = require('crypto');

const NOWPAYMENTS_API_BASE = 'https://api.nowpayments.io/v1';

async function createInvoice({
  apiKey,
  priceAmount,
  priceCurrency = 'uah',
  orderId,
  orderDescription,
  ipnCallbackUrl,
  successUrl,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch недоступний у цьому середовищі.');
  }
  if (!apiKey) {
    throw new Error('Потрібен NOWPAYMENTS_API_KEY.');
  }

  const response = await fetchImpl(`${NOWPAYMENTS_API_BASE}/invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      price_amount: priceAmount,
      price_currency: priceCurrency,
      order_id: orderId,
      order_description: orderDescription,
      ipn_callback_url: ipnCallbackUrl,
      success_url: successUrl,
      is_fixed_rate: true,
      is_fee_paid_by_user: true,
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.invoice_url) {
    const message = (data && (data.message || data.code)) || `HTTP ${response.status}`;
    throw new Error(`NOWPayments createInvoice: ${message}`);
  }
  return { invoiceUrl: data.invoice_url, id: data.id };
}

// IPN-підпис NOWPayments: HMAC-SHA512(IPN secret, JSON.stringify(payload
// із рекурсивно відсортованими ключами)) — порівнюється з заголовком
// x-nowpayments-sig. Сортувати треба рекурсивно (не лише верхній рівень),
// інакше вкладені об'єкти ламають збіг підпису.
function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObjectKeys(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function verifyIpnSignature({ rawBody, signatureHeader, ipnSecret }) {
  if (!rawBody || !signatureHeader || !ipnSecret) return false;

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }

  const sortedJson = JSON.stringify(sortObjectKeys(parsed));
  const expected = crypto.createHmac('sha512', ipnSecret).update(sortedJson, 'utf8').digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signatureHeader), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createInvoice, verifyIpnSignature, sortObjectKeys };
