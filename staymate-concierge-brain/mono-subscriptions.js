'use strict';
const crypto = require('node:crypto');
const monoClient = require('./mono-acquiring');

const PLANS = Object.freeze({
  start: { label: 'Старт', priceUah: 4999 },
  pro: { label: 'Профі', priceUah: 9999 },
  network: { label: 'Мережа', priceUah: 14999 },
});

class MonoSubscriptionError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'MonoSubscriptionError';
    this.statusCode = statusCode;
  }
}

function createMonoSubscriptions({ db, merchantToken, apiBaseUrl, mono = monoClient, onSubscriptionActivated = () => {} }) {
  if (!db || typeof db.from !== 'function' || typeof db.rpc !== 'function') {
    throw new Error('Database client is required');
  }
  if (typeof merchantToken !== 'string' || !merchantToken.trim()) {
    throw new Error('MONO_MERCHANT_TOKEN is missing');
  }
  let webHookUrl;
  try {
    const url = new URL(apiBaseUrl);
    if (url.protocol !== 'https:') throw new Error();
    webHookUrl = url.origin + '/webhook/mono-subscription';
  } catch {
    throw new Error('API_BASE_URL must be public HTTPS');
  }
  let publicKey;
  let keyFetchedAt = 0;

  async function createSubscriptionInvoice({ authToken, propertyId, plan }) {
    if (!authToken || typeof authToken !== 'string') {
      throw new MonoSubscriptionError('Потрібна авторизація.', 401);
    }
    if (!propertyId || typeof propertyId !== 'string' || !PLANS[plan]) {
      throw new MonoSubscriptionError('Невірні дані підписки.', 400);
    }
    const { data: userData, error: authError } = await db.auth.getUser(authToken);
    const user = userData?.user;
    if (authError || !user?.id) throw new MonoSubscriptionError('Недійсна сесія.', 401);
    const { data: property, error: propertyError } = await db
      .from('properties')
      .select('property_id,hotel_name')
      .eq('property_id', propertyId)
      .eq('owner_id', user.id)
      .maybeSingle();
    if (propertyError) throw new MonoSubscriptionError('Помилка доступу до готелю.', 503);
    if (!property) throw new MonoSubscriptionError('Готель недоступний.', 403);
    const info = PLANS[plan];
    const orderId = 'SUB' + crypto.randomBytes(12).toString('hex').toUpperCase();
    const { invoiceId, invoiceUrl } = await mono.createInvoice({
      token: merchantToken,
      amountKopecks: info.priceUah * 100,
      reference: orderId,
      destination: 'StayAI: ' + info.label,
      webHookUrl,
      redirectUrl: 'https://stayai.online/cabinet/',
    });
    const { error: insertError } = await db.from('subscription_orders').insert({
      order_id: orderId,
      property_id: propertyId,
      plan,
      status: 'pending',
      amount_uah: info.priceUah,
      payment_provider: 'monobank',
      mono_invoice_id: invoiceId,
      is_trial_card: false,
    });
    if (insertError) {
      // The already-created invoice is never exposed to the client when DB
      // persistence fails. An orphan cannot activate any subscription.
      throw new MonoSubscriptionError('Не вдалося зберегти рахунок.', 503);
    }
    return { invoiceUrl, orderId, priceUah: info.priceUah, paymentProvider: 'monobank' };
  }

  async function fetchPublicKey() {
    if (publicKey && Date.now() - keyFetchedAt < 60 * 60 * 1000) return publicKey;
    publicKey = await mono.getWebhookPublicKey({ token: merchantToken });
    keyFetchedAt = Date.now();
    return publicKey;
  }

  // Called only by a server endpoint with the *raw* body and X-Sign header.
  // Finalization uses one DB transaction; never directly update a plan here.
  async function receiveSignedWebhook({ rawBody, xSign }) {
    if (!(Buffer.isBuffer(rawBody) || typeof rawBody === 'string') ||
        Buffer.byteLength(rawBody) > 64 * 1024 ||
        !xSign || typeof xSign !== 'string') {
      throw new MonoSubscriptionError('Invalid webhook.', 400);
    }
    const key = await fetchPublicKey();
    if (!mono.verifyWebhookSignature({ publicKeyBase64: key, rawBody, signatureBase64: xSign })) {
      throw new MonoSubscriptionError('Invalid webhook signature.', 401);
    }
    let event;
    try { event = JSON.parse(rawBody.toString()); } catch {
      throw new MonoSubscriptionError('Invalid webhook body.', 400);
    }
    if (!event || typeof event.invoiceId !== 'string') {
      throw new MonoSubscriptionError('Missing invoice ID.', 400);
    }
    if (event.status !== 'success') return { acknowledged: true, credited: false };

    const { data: order, error: readError } = await db
      .from('subscription_orders')
      .select('order_id,property_id,amount_uah,status,payment_provider,mono_invoice_id,is_trial_card')
      .eq('mono_invoice_id', event.invoiceId)
      .maybeSingle();
    if (readError) throw new MonoSubscriptionError('Subscription lookup error.', 503);
    if (!order || order.payment_provider !== 'monobank' || order.is_trial_card === true) {
      throw new MonoSubscriptionError('Invoice not recognized.', 404);
    }
    const amountKopecks = Number(order.amount_uah) * 100;
    if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) {
      throw new MonoSubscriptionError('Invalid order amount.', 409);
    }
    // Defensive reconciliation with the acquiring provider. Webhook alone
    // cannot confirm successful crediting.
    const status = await mono.getInvoiceStatus({ token: merchantToken, invoiceId: event.invoiceId });
    if (!mono.matchesPaidInvoice(status, {
      invoiceId: order.mono_invoice_id,
      reference: order.order_id,
      amountKopecks,
    })) throw new MonoSubscriptionError('Paid invoice details mismatch.', 409);
    const { data: finalResult, error: finalizeError } = await db.rpc('finalize_mono_subscription', {
      p_invoice_id: event.invoiceId,
      p_reference: order.order_id,
      p_amount_kopecks: amountKopecks,
    });
    if (finalizeError) throw new MonoSubscriptionError('Could not finalize subscription.', 503);
    const state = Array.isArray(finalResult) ? finalResult[0]?.result : finalResult?.result;
    if (state !== 'paid' && state !== 'already_paid' && state !== 'paid_test') {
      throw new MonoSubscriptionError('Unexpected finalization result.', 503);
    }
    if (state === 'paid') onSubscriptionActivated(order.property_id);
    return { acknowledged: true, credited: state === 'paid',
      duplicate: state === 'already_paid', testPaid: state === 'paid_test' };
  }

  return { createSubscriptionInvoice, receiveSignedWebhook };
}

module.exports = { PLANS, MonoSubscriptionError, createMonoSubscriptions };
